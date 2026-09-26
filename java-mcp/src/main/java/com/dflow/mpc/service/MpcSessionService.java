package com.dflow.mpc.service;

import com.dflow.mpc.store.SessionStore;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class MpcSessionService {
    private final SessionStore sessionStore;

    public MpcSessionService(SessionStore sessionStore) {
        this.sessionStore = sessionStore;
    }

    public String createSession(String sessionId, List<String> participants, int threshold, String message) {
        if (sessionId == null || sessionId.isBlank()) {
            throw new IllegalArgumentException("sessionId is required");
        }
        if (participants == null || participants.isEmpty()) {
            throw new IllegalArgumentException("participants are required");
        }
        if (threshold < 1 || threshold > participants.size()) {
            throw new IllegalArgumentException("invalid threshold for participant set");
        }

        Map<String, Object> session = new ConcurrentHashMap<>();
        session.put("sessionId", sessionId);
        session.put("participants", participants);
        session.put("threshold", threshold);
        session.put("message", message);
        session.put("phase", "INIT");
        session.put("ready", false);

        sessionStore.save(sessionId, session);
        return sessionId;
    }

    public Map<String, Object> getSession(String sessionId) {
        return sessionStore.get(sessionId);
    }

    public void markReady(String sessionId) {
        Map<String, Object> session = sessionStore.get(sessionId);
        if (session != null) {
            session.put("ready", true);
            session.put("phase", "READY");
        }
    }
}
