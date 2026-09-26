package com.dflow.mpc.protocol;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

public final class MpcProtocol {
    private MpcProtocol() {
    }

    public static byte[] encodeVarint(long value) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        long v = value;
        while (true) {
            int byteValue = (int) (v & 0x7FL);
            v >>>= 7;
            if (v != 0) {
                byteValue |= 0x80;
            }
            out.write(byteValue);
            if (v == 0) {
                break;
            }
        }
        return out.toByteArray();
    }

    public static byte[] encodeStringField(int fieldNumber, String value) {
        byte[] data = value.getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(encodeVarint(((long) fieldNumber << 3) | 2L));
        out.writeBytes(encodeVarint(data.length));
        out.write(data, 0, data.length);
        return out.toByteArray();
    }

    public static byte[] encodeBytesField(int fieldNumber, byte[] value) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(encodeVarint(((long) fieldNumber << 3) | 2L));
        out.writeBytes(encodeVarint(value.length));
        out.write(value, 0, value.length);
        return out.toByteArray();
    }

    public static byte[] encodeEnvelope(String route, String sessionId, String participantId, byte[] payload) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(encodeStringField(1, route));
        out.writeBytes(encodeStringField(2, sessionId));
        out.writeBytes(encodeStringField(3, participantId));
        out.writeBytes(encodeBytesField(4, payload));
        return out.toByteArray();
    }

    public static Map<String, Object> decodeEnvelope(byte[] body) {
        Map<String, Object> result = new HashMap<>();
        int[] index = {0};
        String route = "";
        String sessionId = "";
        String participantId = "";
        byte[] payload = new byte[0];

        while (index[0] < body.length) {
            long tag = readVarint(body, index);
            int fieldNumber = (int) (tag >> 3);
            int wireType = (int) (tag & 0x07L);
            if (wireType != 2) {
                throw new IllegalArgumentException("Unsupported wire type: " + wireType + " for field " + fieldNumber);
            }
            int length = (int) readVarint(body, index);
            if (length < 0 || index[0] + length > body.length) {
                throw new IllegalArgumentException("Invalid field length for field " + fieldNumber);
            }
            byte[] fieldBytes = new byte[length];
            System.arraycopy(body, index[0], fieldBytes, 0, length);
            index[0] += length;

            switch (fieldNumber) {
                case 1 -> route = new String(fieldBytes, StandardCharsets.UTF_8);
                case 2 -> sessionId = new String(fieldBytes, StandardCharsets.UTF_8);
                case 3 -> participantId = new String(fieldBytes, StandardCharsets.UTF_8);
                case 4 -> payload = fieldBytes;
                default -> { }
            }
        }

        result.put("route", route);
        result.put("sessionId", sessionId);
        result.put("participantId", participantId);
        result.put("payloadBase64", Base64.getEncoder().encodeToString(payload));
        result.put("payloadText", new String(payload, StandardCharsets.UTF_8));
        return result;
    }

    public static long readVarint(byte[] body, int[] index) {
        long result = 0L;
        int shift = 0;
        while (index[0] < body.length) {
            int current = body[index[0]] & 0xFF;
            index[0]++;
            result |= ((long) (current & 0x7F)) << shift;
            if ((current & 0x80) == 0) {
                return result;
            }
            shift += 7;
        }
        throw new IllegalArgumentException("Malformed varint");
    }
}
