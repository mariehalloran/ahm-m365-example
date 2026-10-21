using './main.bicep'

// Compile-only image placeholder, not a published image.
param workerImage = 'REPLACE_WITH_APPROVED_IMAGE_URI'
param workerEntrypoint = 'dist/exchange/src/worker.js'

param identityName = 'uami-exchange-synthetic-mock'
param environmentName = 'cae-exchange-synthetic-mock'
param appName = 'ca-exchange-synthetic-mock'

param deployWorker = false
param enableLiveProbe = false
param intervalSeconds = 60
param timeoutSeconds = 45
