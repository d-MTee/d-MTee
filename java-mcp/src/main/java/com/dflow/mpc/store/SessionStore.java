package com.dflow.mpc.store;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class SessionStore {
    private final Map<String, Map<String, Object>> sessions = new ConcurrentHashMap<>();

    public void save(String sessionId, Map<String, Object> state) {
        sessions.put(sessionId, state);
    }

    public Map<String, Object> get(String sessionId) {
        return sessions.get(sessionId);
    }

    public void remove(String sessionId) {
        sessions.remove(sessionId);
    }

    public boolean exists(String sessionId) {
        return sessions.containsKey(sessionId);
    }
}
