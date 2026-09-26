package com.dflow.mpc.client;

import java.util.Base64;
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

    public Map<String, Object> registerParticipant(String sessionId) {
        return Map.of(
            "participantId", participantId,
            "host", host,
            "port", port,
            "sessionId", sessionId,
            "status", "registered"
        );
    }

    public Map<String, Object> dkgRound1(String sessionId) {
        return Map.of(
            "participantId", participantId,
            "sessionId", sessionId,
            "round", "DKG_1",
            "payloadBase64", Base64.getEncoder().encodeToString((participantId + ":dkg-round-1").getBytes())
        );
    }

    public Map<String, Object> dkgRound2(String sessionId, byte[] round1Secret, byte[] peerPackages) {
        return Map.of(
            "participantId", participantId,
            "sessionId", sessionId,
            "round", "DKG_2",
            "round1SecretLength", round1Secret.length,
            "peerPackagesLength", peerPackages.length
        );
    }

    public Map<String, Object> signRound1(String sessionId, byte[] message) {
        return Map.of(
            "participantId", participantId,
            "sessionId", sessionId,
            "round", "SIGN_1",
            "messageLength", message.length
        );
    }

    public Map<String, Object> signRound2(String sessionId, byte[] signingPackage, byte[] nonce, byte[] keyPackage) {
        return Map.of(
            "participantId", participantId,
            "sessionId", sessionId,
            "round", "SIGN_2",
            "signingPackageLength", signingPackage.length,
            "nonceLength", nonce.length,
            "keyPackageLength", keyPackage.length
        );
    }
}
