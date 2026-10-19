# Teams probe — NOT IMPLEMENTED

This folder contains a disabled [service config](./config.json) with its own intended cadence, but no working Teams probe or simulation. The generic config-driven worker accepts the disabled config and refuses to enable it until a Teams handler exists. No live permission grant is supplied. A Teams entity in the health model does not establish Teams health; absent evidence must not be reported as Healthy.

Deploy the [health model first](../../health-model/README.md). Future Teams journeys require approved dedicated resources and validation of supported endpoint authentication, permissions, licensing, retention and cleanup. A metadata read would demonstrate API reachability, not calling or meeting/media experience.

See the [service recommendations](../../docs/product-recommendations.md#teams-deliberately-staged). No Teams implementation is included in this restructuring.
