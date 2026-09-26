package com.dflow.mpc.flow;

import com.dflow.mpc.MpcMcpServer;

import java.util.List;
import java.util.Map;

public class RoundSequenceSimulator {
    public static void main(String[] args) {
        MpcMcpServer server = new MpcMcpServer(9090);
        String sessionId = "sess-round-sim-001";

        server.createSession(sessionId, List.of("p1", "p2", "p3"), 2, "demo-message");
        List<Map<String, Object>> results = server.simulateRoundSequence(sessionId);

        for (Map<String, Object> step : results) {
            System.out.println(step);
        }

        System.out.println("[sim] session create -> participant register -> dkg relay -> sign relay complete");
    }
}
