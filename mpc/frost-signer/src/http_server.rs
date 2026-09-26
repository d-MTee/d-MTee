use std::collections::HashMap;
use std::error::Error;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Default)]
pub struct ParticipantHttpServer {
    participant_id: String,
    host: String,
    port: u16,
    threshold: u16,
    total_participants: u16,
    sessions: Arc<Mutex<HashMap<String, String>>>,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct RoundEnvelope {
    route: String,
    session_id: String,
    participant_id: String,
    payload: Vec<u8>,
}

fn encode_varint(value: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut v = value;
    loop {
        let mut byte = (v & 0x7F) as u8;
        v >>= 7;
        if v != 0 {
            byte |= 0x80;
        }
        bytes.push(byte);
        if v == 0 {
            break;
        }
    }
    bytes
}

fn encode_tag(field_number: u32, wire_type: u32) -> Vec<u8> {
    encode_varint(((field_number as u64) << 3) | wire_type as u64)
}

fn encode_length_delimited(bytes: &[u8]) -> Vec<u8> {
    let mut out = encode_varint(bytes.len() as u64);
    out.extend_from_slice(bytes);
    out
}

fn encode_string_field(field_number: u32, value: &str) -> Vec<u8> {
    let encoded = value.as_bytes();
    let mut out = encode_tag(field_number, 2);
    out.extend_from_slice(&encode_length_delimited(encoded));
    out
}

fn encode_bytes_field(field_number: u32, value: &[u8]) -> Vec<u8> {
    let mut out = encode_tag(field_number, 2);
    out.extend_from_slice(&encode_length_delimited(value));
    out
}

fn encode_round_envelope(env: &RoundEnvelope) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&encode_string_field(1, &env.route));
    out.extend_from_slice(&encode_string_field(2, &env.session_id));
    out.extend_from_slice(&encode_string_field(3, &env.participant_id));
    out.extend_from_slice(&encode_bytes_field(4, &env.payload));
    out
}

fn decode_varint(buf: &[u8], index: &mut usize) -> Option<u64> {
    let mut result = 0u64;
    let mut shift = 0u32;
    loop {
        if *index >= buf.len() {
            return None;
        }
        let byte = buf[*index];
        *index += 1;
        result |= ((byte & 0x7F) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
    }
}

fn decode_length_delimited(buf: &[u8], index: &mut usize) -> Option<Vec<u8>> {
    let len = decode_varint(buf, index)? as usize;
    if *index + len > buf.len() {
        return None;
    }
    let value = buf[*index..*index + len].to_vec();
    *index += len;
    Some(value)
}

fn decode_round_envelope(payload: &[u8]) -> Result<RoundEnvelope, String> {
    let mut index = 0usize;
    let mut env = RoundEnvelope::default();

    while index < payload.len() {
        let tag = decode_varint(payload, &mut index).ok_or_else(|| "invalid field tag".to_string())?;
        let field_no = (tag >> 3) as u32;
        let wire_type = (tag & 0x07) as u32;
        if wire_type != 2 {
            return Err(format!("unsupported wire type {wire_type} for field {field_no}"));
        }
        let value = decode_length_delimited(payload, &mut index).ok_or_else(|| "invalid length-delimited field".to_string())?;
        match field_no {
            1 => env.route = String::from_utf8(value).map_err(|_| "invalid route".to_string())?,
            2 => env.session_id = String::from_utf8(value).map_err(|_| "invalid session id".to_string())?,
            3 => env.participant_id = String::from_utf8(value).map_err(|_| "invalid participant id".to_string())?,
            4 => env.payload = value,
            _ => {}
        }
    }

    Ok(env)
}

impl ParticipantHttpServer {
    pub fn new(participant_id: &str, host: &str, port: u16, threshold: u16, total_participants: u16) -> Self {
        Self {
            participant_id: participant_id.to_string(),
            host: host.to_string(),
            port,
            threshold,
            total_participants,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn start(&self) -> Result<(), Box<dyn Error>> {
        let addr = format!("{}:{}", self.host, self.port);
        let listener = TcpListener::bind(&addr)?;
        println!("[http] {} listening on {}", self.participant_id, addr);

        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let _ = self.handle_connection(stream);
                }
                Err(err) => {
                    eprintln!("[http] accept failed: {err}");
                }
            }
        }

        Ok(())
    }

    fn handle_connection(&self, mut stream: TcpStream) -> Result<(), Box<dyn Error>> {
        let mut buffer = [0u8; 65535];
        let bytes_read = stream.read(&mut buffer)?;
        let request = String::from_utf8_lossy(&buffer[..bytes_read]);

        let request_line = request.lines().next().unwrap_or("");
        let path = request_line.split_whitespace().nth(1).unwrap_or("/").to_string();
        let content_length = request
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("content-length:"))
            .and_then(|line| line.split(':').nth(1))
            .map(|value| value.trim().parse::<usize>().unwrap_or(0))
            .unwrap_or(0);

        let body_start = request.find("\r\n\r\n").map(|idx| idx + 4).unwrap_or(0);
        let body = &buffer[body_start..body_start + content_length.min(bytes_read - body_start)];

        let response_body = self.dispatch(&path, body)?;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response_body.len(),
            response_body
        );

        stream.write_all(response.as_bytes())?;
        stream.flush()?;
        Ok(())
    }

    fn dispatch(&self, path: &str, body: &[u8]) -> Result<Vec<u8>, Box<dyn Error>> {
        let mut session_id = String::new();
        let mut participant_id = self.participant_id.clone();
        let mut payload = Vec::new();

        if !body.is_empty() {
            let envelope = decode_round_envelope(body)?;
            session_id = envelope.session_id;
            participant_id = envelope.participant_id;
            payload = envelope.payload;
        }

        match path {
            "/health" => Ok(encode_round_envelope(&RoundEnvelope {
                route: "health".to_string(),
                session_id: session_id.clone(),
                participant_id: participant_id.clone(),
                payload: serde_json::json!({
                    "status": "ok",
                    "participant_id": participant_id,
                    "port": self.port,
                    "threshold": self.threshold,
                    "total_participants": self.total_participants
                }).to_string().into_bytes(),
            })),
            "/register" => {
                if session_id.is_empty() {
                    session_id = format!("session-{}", self.port);
                }
                self.sessions.lock().unwrap().insert(session_id.clone(), participant_id.clone());
                Ok(encode_round_envelope(&RoundEnvelope {
                    route: "register".to_string(),
                    session_id: session_id.clone(),
                    participant_id: participant_id.clone(),
                    payload: serde_json::json!({
                        "status": "registered",
                        "session_id": session_id,
                        "participant_id": participant_id,
                        "threshold": self.threshold,
                        "total_participants": self.total_participants
                    }).to_string().into_bytes(),
                }))
            }
            "/dkg/round1" | "/dkg/round1/" => Ok(encode_round_envelope(&RoundEnvelope {
                route: "dkg_round1".to_string(),
                session_id: session_id.clone(),
                participant_id: participant_id.clone(),
                payload: serde_json::json!({
                    "status": "dkg-round-1-ready",
                    "session_id": session_id,
                    "participant_id": participant_id,
                    "threshold": self.threshold,
                    "total_participants": self.total_participants,
                    "payload_hex": hex::encode(payload)
                }).to_string().into_bytes(),
            })),
            "/dkg/round2" | "/dkg/round2/" => Ok(encode_round_envelope(&RoundEnvelope {
                route: "dkg_round2".to_string(),
                session_id: session_id.clone(),
                participant_id: participant_id.clone(),
                payload: serde_json::json!({
                    "status": "dkg-round-2-ready",
                    "session_id": session_id,
                    "participant_id": participant_id,
                    "round1_secret_length": payload.len(),
                    "threshold": self.threshold,
                    "total_participants": self.total_participants
                }).to_string().into_bytes(),
            })),
            "/sign/round1" | "/sign/round1/" => Ok(encode_round_envelope(&RoundEnvelope {
                route: "sign_round1".to_string(),
                session_id: session_id.clone(),
                participant_id: participant_id.clone(),
                payload: serde_json::json!({
                    "status": "sign-round-1-ready",
                    "session_id": session_id,
                    "participant_id": participant_id,
                    "message_length": payload.len(),
                    "threshold": self.threshold,
                    "total_participants": self.total_participants
                }).to_string().into_bytes(),
            })),
            "/sign/round2" | "/sign/round2/" => Ok(encode_round_envelope(&RoundEnvelope {
                route: "sign_round2".to_string(),
                session_id: session_id.clone(),
                participant_id: participant_id.clone(),
                payload: serde_json::json!({
                    "status": "sign-round-2-ready",
                    "session_id": session_id,
                    "participant_id": participant_id,
                    "signature_share_length": payload.len(),
                    "threshold": self.threshold,
                    "total_participants": self.total_participants
                }).to_string().into_bytes(),
            })),
            _ => Ok(encode_round_envelope(&RoundEnvelope {
                route: "unknown".to_string(),
                session_id: session_id.clone(),
                participant_id: participant_id.clone(),
                payload: serde_json::json!({
                    "status": "unknown-route",
                    "participant_id": participant_id,
                    "path": path
                }).to_string().into_bytes(),
            })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_envelope_roundtrip_works() {
        let envelope = RoundEnvelope {
            route: "register".to_string(),
            session_id: "sess-1".to_string(),
            participant_id: "p1".to_string(),
            payload: b"{\"status\":\"ok\"}".to_vec(),
        };
        let encoded = encode_round_envelope(&envelope);
        let decoded = decode_round_envelope(&encoded).unwrap();
        assert_eq!(decoded, envelope);
    }
}
