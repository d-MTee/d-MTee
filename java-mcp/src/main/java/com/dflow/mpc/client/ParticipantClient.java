package com.dflow.mpc.client;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Map;

public class ParticipantClient {
    private final String participantId;
    private final String host;
    private final int port;
    private final HttpClient httpClient;

    public ParticipantClient(String participantId, String host, int port) {
        this.participantId = participantId;
        this.host = host;
        this.port = port;
        this.httpClient = HttpClient.newHttpClient();
    }

    public String getParticipantId() {
        return participantId;
    }

    public Map<String, Object> dkgRound1(String sessionId) {
        return Map.of(
            "participantId", participantId,
            "sessionId", sessionId,
            "status", "round1-generated"
        );
    }

    public Map<String, Object> dkgRound2(String sessionId, byte[] round1Secret, byte[] peerPackages) {
        return Map.of(
            "participantId", participantId,
            "sessionId", sessionId,
            "status", "round2-generated",
            "round1SecretSize", round1Secret.length,
            "peerPackagesSize", peerPackages.length
        );
    }

    public Map<String, Object> signRound1(String sessionId, byte[] message) {
        return Map.of(
            "participantId", participantId,
            "sessionId", sessionId,
            "messageLength", message.length,
            "status", "nonce-generated"
        );
    }

    public Map<String, Object> signRound2(String sessionId, byte[] signingPackage, byte[] nonce, byte[] keyPackage) {
        return Map.of(
            "participantId", participantId,
            "sessionId", sessionId,
            "status", "signature-share-generated",
            "packageLength", signingPackage.length,
            "nonceLength", nonce.length,
            "keyPackageLength", keyPackage.length
        );
    }

    private HttpRequest buildGetRequest(String path) {
        URI uri = URI.create("http://" + host + ":" + port + path);
        return HttpRequest.newBuilder()
            .uri(uri)
            .header("Content-Type", "application/json")
            .GET()
            .build();
    }

    public HttpResponse<String> ping() {
        try {
            HttpRequest request = buildGetRequest("/health");
            return httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException("participant ping failed: " + participantId, e);
        }
    }
}
