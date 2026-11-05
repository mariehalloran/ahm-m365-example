# Architecture (simple Exchange example)

This is the minimal runtime view: one coordinator Container App dispatching one
Exchange execution Function per selected case.

```mermaid
flowchart LR
    ca["Container App coordinator"] -->|"POST /api/lanes/start"| fx["Azure Function App (Exchange)"]
    subgraph ex["Exchange execution Function"]
        s1["1. Validate dispatch and lock lane"]
        s2["2. Execute journey steps<br/>create-draft -> send -> confirm-delivery"]
        s3["3. Publish outcome directly"]
        s1 --> s2 --> s3
    end
    fx --> ex
```

The coordinator only schedules and dispatches. It does not aggregate results.
The execution Function owns the journey run and publishes outcomes directly.
