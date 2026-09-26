package com.dflow.mpc;

import com.dflow.mpc.client.ParticipantGrpcClient;
import com.dflow.mpc.service.MpcSessionService;
import com.dflow.mpc.store.SessionStore;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

public class MpcMcpServer {
    private final int port;
    private final MpcSessionService sessionService;
    private final AtomicBoolean running = new AtomicBoolean(false);

    public MpcMcpServer(int port) {
        this.port = port;
        this.sessionService = new MpcSessionService(new SessionStore());
    }

    public void start() throws IOException {
        if (running.compareAndSet(false, true)) {
            System.out.println("[mcp] starting Java MCP server on port " + port);
            System.out.println("[mcp] ready for DKG and signing orchestration");
        }
    }

    public void stop() {
        running.set(false);
        System.out.println("[mcp] Java MCP server stopped");
    }

    public String createSession(String sessionId, List<String> participants, int threshold, String message) {
        return sessionService.createSession(sessionId, participants, threshold, message);
    }

    public Map<String, Object> registerParticipant(String sessionId, String participantId, String host, int port) {
        ParticipantGrpcClient client = new ParticipantGrpcClient(participantId, host, port);
        return client.registerParticipant(sessionId);
    }

    public Map<String, Object> relayDkgRound1(String sessionId, String participantId, String host, int port) {
        ParticipantGrpcClient client = new ParticipantGrpcClient(participantId, host, port);
        return client.dkgRound1(sessionId);
    }

    public Map<String, Object> relayDkgRound2(String sessionId, String participantId, String host, int port, byte[] round1Secret, byte[] peerPackages) {
        ParticipantGrpcClient client = new ParticipantGrpcClient(participantId, host, port);
        return client.dkgRound2(sessionId, round1Secret, peerPackages);
    }

    public Map<String, Object> relaySignRound1(String sessionId, String participantId, String host, int port, byte[] message) {
        ParticipantGrpcClient client = new ParticipantGrpcClient(participantId, host, port);
        return client.signRound1(sessionId, message);
    }

    public Map<String, Object> relaySignRound2(String sessionId, String participantId, String host, int port, byte[] signingPackage, byte[] nonce, byte[] keyPackage) {
        ParticipantGrpcClient client = new ParticipantGrpcClient(participantId, host, port);
        return client.signRound2(sessionId, signingPackage, nonce, keyPackage);
    }

    public List<Map<String, Object>> simulateRoundSequence(String sessionId) {
        List<Map<String, Object>> results = new ArrayList<>();
        results.add(registerParticipant(sessionId, "p1", "127.0.0.1", 9001));
        results.add(registerParticipant(sessionId, "p2", "127.0.0.1", 9002));
        results.add(registerParticipant(sessionId, "p3", "127.0.0.1", 9003));
        results.add(relayDkgRound1(sessionId, "p1", "127.0.0.1", 9001));
        results.add(relayDkgRound1(sessionId, "p2", "127.0.0.1", 9002));
        results.add(relayDkgRound1(sessionId, "p3", "127.0.0.1", 9003));
        results.add(relayDkgRound2(sessionId, "p1", "127.0.0.1", 9001, new byte[] {1}, new byte[] {2, 3}));
        results.add(relayDkgRound2(sessionId, "p2", "127.0.0.1", 9002, new byte[] {4}, new byte[] {5, 6}));
        results.add(relayDkgRound2(sessionId, "p3", "127.0.0.1", 9003, new byte[] {7}, new byte[] {8, 9}));
        results.add(relaySignRound1(sessionId, "p1", "127.0.0.1", 9001, "demo-message".getBytes()));
        results.add(relaySignRound1(sessionId, "p2", "127.0.0.1", 9002, "demo-message".getBytes()));
        results.add(relaySignRound2(sessionId, "p1", "127.0.0.1", 9001, new byte[] {10}, new byte[] {11}, new byte[] {12}));
        results.add(relaySignRound2(sessionId, "p2", "127.0.0.1", 9002, new byte[] {13}, new byte[] {14}, new byte[] {15}));
        return results;
    }

    public static void main(String[] args) {
        int port = 9090;
        if (args.length > 0) {
            port = Integer.parseInt(args[0]);
        }

        MpcMcpServer server = new MpcMcpServer(port);
        try {
            server.start();
            Thread.sleep(Long.MAX_VALUE);
        } catch (Exception e) {
            e.printStackTrace();
            System.exit(1);
        }
    }
}
