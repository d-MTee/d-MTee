package com.dflow.mpc.flow;

import com.dflow.mpc.protocol.MpcProtocol;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;

public class ParticipantRoundHttpServer {
    private final String participantId;
    private final int port;
    private final HttpServer server;

    public ParticipantRoundHttpServer(String participantId, int port) throws IOException {
        this.participantId = participantId;
        this.port = port;
        this.server = HttpServer.create(new InetSocketAddress(port), 0);
        this.server.createContext("/register", this::handleRegister);
        this.server.createContext("/dkg/round1", this::handleDkgRound1);
        this.server.createContext("/dkg/round2", this::handleDkgRound2);
        this.server.createContext("/sign/round1", this::handleSignRound1);
        this.server.createContext("/sign/round2", this::handleSignRound2);
        this.server.setExecutor(null);
    }

    public void start() {
        server.start();
        System.out.println("[http] " + participantId + " listening on port " + port);
    }

    public void stop() {
        server.stop(0);
    }

    private static byte[] readAllBytes(HttpExchange exchange) throws IOException {
        try (InputStream is = exchange.getRequestBody()) {
            return is.readAllBytes();
        }
    }

    private void writeEnvelope(HttpExchange exchange, String route, String sessionId, String payloadJson) throws IOException {
        byte[] payload = payloadJson.getBytes(StandardCharsets.UTF_8);
        byte[] body = MpcProtocol.encodeEnvelope(route, sessionId, participantId, payload);
        exchange.getResponseHeaders().add("Content-Type", "application/octet-stream");
        exchange.sendResponseHeaders(200, body.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(body);
        }
    }

    private void handleRegister(HttpExchange exchange) throws IOException {
        Map<String, Object> request = MpcProtocol.decodeEnvelope(readAllBytes(exchange));
        String sessionId = (String) request.getOrDefault("sessionId", "session-0001");
        writeEnvelope(exchange, "register", sessionId, "{\"status\":\"registered\",\"participantId\":\"" + participantId + "\"}");
    }

    private void handleDkgRound1(HttpExchange exchange) throws IOException {
        Map<String, Object> request = MpcProtocol.decodeEnvelope(readAllBytes(exchange));
        String sessionId = (String) request.getOrDefault("sessionId", "session-0001");
        writeEnvelope(exchange, "dkg/round1", sessionId, "{\"status\":\"dkg-round-1-ready\",\"participantId\":\"" + participantId + "\"}");
    }

    private void handleDkgRound2(HttpExchange exchange) throws IOException {
        Map<String, Object> request = MpcProtocol.decodeEnvelope(readAllBytes(exchange));
        String sessionId = (String) request.getOrDefault("sessionId", "session-0001");
        writeEnvelope(exchange, "dkg/round2", sessionId, "{\"status\":\"dkg-round-2-ready\",\"participantId\":\"" + participantId + "\"}");
    }

    private void handleSignRound1(HttpExchange exchange) throws IOException {
        Map<String, Object> request = MpcProtocol.decodeEnvelope(readAllBytes(exchange));
        String sessionId = (String) request.getOrDefault("sessionId", "session-0001");
        writeEnvelope(exchange, "sign/round1", sessionId, "{\"status\":\"sign-round-1-ready\",\"participantId\":\"" + participantId + "\"}");
    }

    private void handleSignRound2(HttpExchange exchange) throws IOException {
        Map<String, Object> request = MpcProtocol.decodeEnvelope(readAllBytes(exchange));
        String sessionId = (String) request.getOrDefault("sessionId", "session-0001");
        writeEnvelope(exchange, "sign/round2", sessionId, "{\"status\":\"sign-round-2-ready\",\"participantId\":\"" + participantId + "\"}");
    }
}
