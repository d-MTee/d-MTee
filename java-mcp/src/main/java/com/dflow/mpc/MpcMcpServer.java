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

        String[] participantIds = {"p1", "p2", "p3"};
        int[] ports = {9001, 9002, 9003};

        for (int i = 0; i < participantIds.length; i++) {
            results.add(registerParticipant(sessionId, participantIds[i], "127.0.0.1", ports[i]));
            results.add(relayDkgRound1(sessionId, participantIds[i], "127.0.0.1", ports[i]));
            results.add(relayDkgRound2(sessionId, participantIds[i], "127.0.0.1", ports[i],
                (participantIds[i] + ":dkg-secret").getBytes(),
                (participantIds[i] + ":peer-package").getBytes()));
            results.add(relaySignRound1(sessionId, participantIds[i], "127.0.0.1", ports[i],
                "demo-message".getBytes()));
            results.add(relaySignRound2(sessionId, participantIds[i], "127.0.0.1", ports[i],
                (participantIds[i] + ":signing-package").getBytes(),
                (participantIds[i] + ":nonce").getBytes(),
                (participantIds[i] + ":key-package").getBytes()));
        }

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
