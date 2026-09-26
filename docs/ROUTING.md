# Routing model

The router treats each quote as an edge in a graph. A route is a sequence of edges. The score is not simply output amount: production routing should optimize expected output after fees, price impact, priority cost and execution risk.

For a route R:

`score(R) = expectedOut - explicitFees - priorityCost - riskPenalty`

JIT routing repeats the quote immediately before execution and rejects the transaction when output drift exceeds policy.

The current split optimizer is deliberately bounded. A production optimizer should use a graph search / dynamic programming approach with bounded hops and venue constraints rather than unbounded combinatorial search.
