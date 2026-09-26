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
        let mut buffer = [0u8; 4096];
        stream.read(&mut buffer)?;

        let request = String::from_utf8_lossy(&buffer);
        let path = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1));

        let response_body = match path {
            Some("/health") => r#"{"status":"ok","participant_id":"#
                .to_string() + &self.participant_id + "","port": " + &self.port.to_string() + "}" ,
            Some("/session") => {
                let session_id = "session-001";
                self.sessions
                    .lock()
                    .map_err(|_| "session lock poisoned")?
                    .insert(session_id.to_string(), "registered".to_string());
                format!(
                    r#"{{"status":"registered","participant_id":"{}","session_id":"{}","threshold":{},"total_participants":{}}}"#,
                    self.participant_id,
                    session_id,
                    self.threshold,
                    self.total_participants
                )
            }
            Some("/dkg") => format!(
                r#"{{"status":"dkg-ready","participant_id":"{}","threshold":{},"total_participants":{}}}"#,
                self.participant_id,
                self.threshold,
                self.total_participants
            ),
            Some("/sign") => format!(
                r#"{{"status":"sign-ready","participant_id":"{}","threshold":{},"total_participants":{}}}"#,
                self.participant_id,
                self.threshold,
                self.total_participants
            ),
            _ => format!(
                r#"{{"status":"unknown-route","participant_id":"{}"}}"#,
                self.participant_id
            ),
        };

        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response_body.len(),
            response_body
        );

        stream.write_all(response.as_bytes())?;
        stream.flush()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_server_state() {
        let server = ParticipantHttpServer::new("p1", "127.0.0.1", 9001, 2, 3);
        assert_eq!(server.participant_id, "p1");
        assert_eq!(server.port, 9001);
    }
}
