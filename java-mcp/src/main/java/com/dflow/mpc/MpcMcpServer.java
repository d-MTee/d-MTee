package com.dflow.mpc;

import com.dflow.mpc.service.MpcSessionService;
import com.dflow.mpc.store.SessionStore;

import java.io.IOException;
import java.util.List;
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
