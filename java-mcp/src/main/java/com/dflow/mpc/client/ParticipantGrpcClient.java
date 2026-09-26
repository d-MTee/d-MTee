package com.dflow.mpc.client;

import com.dflow.mpc.protocol.MpcProtocol;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import mpc.v1.MpcService;
import mpc.v1.ParticipantSignerGrpc;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public class ParticipantGrpcClient {
    private final String participantId;
    private final String host;
    private final int port;

    public ParticipantGrpcClient(String participantId, String host, int port) {
        this.participantId = participantId;
        this.host = host;
        this.port = port;
    }

    private int grpcPort() {
        return port + 1000;
    }

    private static byte[] stripHttpHeaders(byte[] raw) {
        String text = new String(raw, StandardCharsets.ISO_8859_1);
        int index = text.indexOf("\r\n\r\n");
        if (index >= 0) {
            return java.util.Arrays.copyOfRange(raw, index + 4, raw.length);
        }
        if (text.startsWith("HTTP/")) {
            int bodyStart = text.indexOf("\n\n");
            if (bodyStart >= 0) {
                return java.util.Arrays.copyOfRange(raw, bodyStart + 2, raw.length);
            }
        }
        return raw;
    }

    private Map<String, Object> exchangeHttp(String route, String sessionId, byte[] payload) {
        try {
            String target = "http://" + host + ":" + port + "/" + route;
            byte[] requestBody = MpcProtocol.encodeEnvelope(route, sessionId, participantId, payload);
            HttpURLConnection conn = (HttpURLConnection) new URL(target).openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/octet-stream");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);

            try (OutputStream os = conn.getOutputStream()) {
                os.write(requestBody);
            }

            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new IOException("participant request failed: HTTP " + code);
            }

            try (InputStream is = conn.getInputStream()) {
                byte[] response = is.readAllBytes();
                return MpcProtocol.decodeEnvelope(stripHttpHeaders(response));
            }
        } catch (IOException e) {
            throw new RuntimeException("participant exchange failed for " + participantId + " on " + host + ":" + port + " route=" + route, e);
        }
    }

    private Map<String, Object> exchangeGrpc(String route, String sessionId, byte[] payload) {
        ManagedChannel channel = ManagedChannelBuilder.forAddress(host, grpcPort()).usePlaintext().build();
        try {
            ParticipantSignerGrpc.ParticipantSignerBlockingStub stub = ParticipantSignerGrpc.newBlockingStub(channel);
            Map<String, Object> result = new HashMap<>();

            switch (route) {
                case "register" -> {
                    MpcService.RegisterParticipantResponse response = stub.registerParticipant(
                        MpcService.RegisterParticipantRequest.newBuilder()
                            .setParticipantId(participantId)
                            .setHost(host)
                            .setRole("participant")
                            .build());
                    result.put("route", route);
                    result.put("sessionId", sessionId);
                    result.put("participantId", participantId);
                    result.put("ok", response.getOk());
                    result.put("status", response.getStatus());
                    return result;
                }
                case "dkg/round1" -> {
                    MpcService.DkgRound1Response response = stub.dkgRound1(
                        MpcService.DkgRound1Request.newBuilder()
                            .setSessionId(sessionId)
                            .setParticipantId(participantId)
                            .setRequestId(sessionId)
                            .build());
                    result.put("route", route);
                    result.put("sessionId", sessionId);
                    result.put("participantId", participantId);
                    result.put("ok", response.getOk());
                    result.put("status", response.getParticipantId());
                    result.put("payloadBase64", java.util.Base64.getEncoder().encodeToString(response.getRound1Package().toByteArray()));
                    return result;
                }
                case "dkg/round2" -> {
                    MpcService.DkgRound2Response response = stub.dkgRound2(
                        MpcService.DkgRound2Request.newBuilder()
                            .setSessionId(sessionId)
                            .setParticipantId(participantId)
                            .setRound1Secret(com.google.protobuf.ByteString.copyFrom(payload))
                            .addRound1Packages(com.google.protobuf.ByteString.copyFrom(payload))
                            .build());
                    result.put("route", route);
                    result.put("sessionId", sessionId);
                    result.put("participantId", participantId);
                    result.put("ok", response.getOk());
                    result.put("status", response.getParticipantId());
                    result.put("payloadBase64", java.util.Base64.getEncoder().encodeToString(response.getRound2Package().toByteArray()));
                    return result;
                }
                case "sign/round1" -> {
                    MpcService.SignRound1Response response = stub.signRound1(
                        MpcService.SignRound1Request.newBuilder()
                            .setSessionId(sessionId)
                            .setParticipantId(participantId)
                            .setMessage(com.google.protobuf.ByteString.copyFrom(payload))
                            .build());
                    result.put("route", route);
                    result.put("sessionId", sessionId);
                    result.put("participantId", participantId);
                    result.put("ok", response.getOk());
                    result.put("status", response.getParticipantId());
                    result.put("payloadBase64", java.util.Base64.getEncoder().encodeToString(response.getCommitment().toByteArray()));
                    return result;
                }
                case "sign/round2" -> {
                    MpcService.SignRound2Response response = stub.signRound2(
                        MpcService.SignRound2Request.newBuilder()
                            .setSessionId(sessionId)
                            .setParticipantId(participantId)
                            .setSigningPackage(com.google.protobuf.ByteString.copyFrom(payload))
                            .setNonce(com.google.protobuf.ByteString.copyFrom(payload))
                            .setSigningKey(com.google.protobuf.ByteString.copyFrom(payload))
                            .build());
                    result.put("route", route);
                    result.put("sessionId", sessionId);
                    result.put("participantId", participantId);
                    result.put("ok", response.getOk());
                    result.put("status", response.getParticipantId());
                    result.put("payloadBase64", java.util.Base64.getEncoder().encodeToString(response.getSignatureShare().toByteArray()));
                    return result;
                }
                default -> {
                    throw new IllegalArgumentException("unsupported gRPC route: " + route);
                }
            }
        } catch (Exception e) {
            throw new RuntimeException("gRPC participant exchange failed for " + participantId + " on " + host + ":" + grpcPort() + " route=" + route, e);
        } finally {
            channel.shutdownNow();
        }
    }

    private Map<String, Object> exchange(String route, String sessionId, byte[] payload) {
        try {
            return exchangeGrpc(route, sessionId, payload);
        } catch (RuntimeException grpcError) {
            return exchangeHttp(route, sessionId, payload);
        }
    }

    public Map<String, Object> registerParticipant(String sessionId) {
        String payload = String.format("{\"participantId\":\"%s\",\"host\":\"%s\",\"port\":%d}", participantId, host, port);
        return exchange("register", sessionId, payload.getBytes(StandardCharsets.UTF_8));
    }

    public Map<String, Object> dkgRound1(String sessionId) {
        return exchange("dkg/round1", sessionId, (participantId + ":dkg-round-1").getBytes(StandardCharsets.UTF_8));
    }

    public Map<String, Object> dkgRound2(String sessionId, byte[] round1Secret, byte[] peerPackages) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(round1Secret, 0, round1Secret.length);
        out.write(new byte[] {0}, 0, 1);
        out.write(peerPackages, 0, peerPackages.length);
        return exchange("dkg/round2", sessionId, out.toByteArray());
    }

    public Map<String, Object> signRound1(String sessionId, byte[] message) {
        return exchange("sign/round1", sessionId, message);
    }

    public Map<String, Object> signRound2(String sessionId, byte[] signingPackage, byte[] nonce, byte[] keyPackage) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(signingPackage, 0, signingPackage.length);
        out.write(new byte[] {0}, 0, 1);
        out.write(nonce, 0, nonce.length);
        out.write(new byte[] {0}, 0, 1);
        out.write(keyPackage, 0, keyPackage.length);
        return exchange("sign/round2", sessionId, out.toByteArray());
    }
}
