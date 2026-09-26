# Java MCP orchestrator skeleton

This directory is the planned Java-side orchestration layer for the distributed FROST signing flow.

## Intended responsibilities

- create and register sessions
- manage participant health and registration
- relay DKG and signing round data between Rust participants
- aggregate signature shares
- validate request IDs and session state
- enforce approval and replay protection

## Proposed structure

```text
java-mcp/
  src/
    app/
      MpcMcpServer.java
      MpcController.java
    service/
      MpcSessionService.java
      DkgOrchestrator.java
      SigningOrchestrator.java
    client/
      ParticipantClient.java
      ParticipantClientFactory.java
    store/
      SessionStore.java
      InMemorySessionRepository.java
    security/
      SessionIdGenerator.java
      ReplayGuard.java
      AuthTokenService.java
    dto/
      CreateSessionRequest.java
      SessionStatus.java
      RoundMessage.java
```

## Critical design rule

Java should orchestrate, not hold the actual cryptographic key shares. The Rust participant nodes should be the components that execute the real FROST operations and keep their key material in protected local storage.

## Future integration steps

1. define the gRPC contract in `mpc/proto/mpc_service.proto`
2. generate the Java stubs from that proto
3. implement the session service
4. add participant client wrappers for P1 / P2 / P3
5. connect the Java service to the Rust participant endpoints
6. apply policy checks before final signature aggregation
