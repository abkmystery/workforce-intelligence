targetScope = 'resourceGroup'

@description('Azure Container Apps managed environment resource ID. It must already have private PostgreSQL, Key Vault, and Blob network access.')
param environmentResourceId string
@description('Existing Azure Database for PostgreSQL flexible server resource ID. The runtime connection URL is supplied separately through Key Vault.')
param postgresServerResourceId string
@description('Existing private Blob storage account resource ID. Blob-backed import/export storage is not yet implemented by the app.')
param blobStorageAccountResourceId string
@description('Existing Key Vault resource ID in the public Azure cloud.')
param keyVaultResourceId string
@description('Existing user-assigned identity resource ID with AcrPull and Key Vault Secrets User grants.')
param userAssignedIdentityResourceId string
@description('Client GUID of the same user-assigned identity; selects it for Azure SDK managed identity credentials.')
param userAssignedIdentityClientId string
@description('Existing Azure Container Registry login server, such as example.azurecr.io.')
param registryLoginServer string
@description('Immutable full image reference, preferably registry/repository@sha256:digest.')
param image string
@description('External HTTPS origin registered with Entra; no trailing path.')
param appUrl string
@description('Comma-separated allowed Entra tenant GUIDs.')
param entraAllowedTenants string
@description('Entra OIDC web application client GUID.')
param entraClientId string
@description('Separate read-only Microsoft Graph application client GUID.')
param graphClientId string

param webAppName string = 'workforce-web'
param workerAppName string = 'workforce-worker'
param location string = resourceGroup().location
param databaseUrlSecretName string = 'workforce-database-url'
param entraClientSecretName string = 'workforce-entra-client-secret'
param graphClientSecretName string = 'workforce-graph-client-secret'
param exportContainerName string = 'workforce-exports'

var keyVaultName = last(split(keyVaultResourceId, '/'))
var storageAccountName = last(split(blobStorageAccountResourceId, '/'))
var secretBase = 'https://${keyVaultName}.vault.azure.net/secrets'
var identityMap = {
  '${userAssignedIdentityResourceId}': {}
}
var imageRegistry = [
  {
    server: registryLoginServer
    identity: userAssignedIdentityResourceId
  }
]

resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: webAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: identityMap
  }
  properties: {
    environmentId: environmentResourceId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: imageRegistry
      secrets: [
        {
          name: 'database-url'
          keyVaultUrl: '${secretBase}/${databaseUrlSecretName}'
          identity: userAssignedIdentityResourceId
        }
        {
          name: 'entra-client-secret'
          keyVaultUrl: '${secretBase}/${entraClientSecretName}'
          identity: userAssignedIdentityResourceId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          command: ['node']
          args: ['server.js']
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'HOSTNAME', value: '0.0.0.0' }
            { name: 'PORT', value: '3000' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'AZURE_STORAGE_ACCOUNT_URL', value: 'https://${storageAccountName}.blob.core.windows.net' }
            { name: 'AZURE_EXPORT_CONTAINER', value: exportContainerName }
            { name: 'AZURE_CLIENT_ID', value: userAssignedIdentityClientId }
            { name: 'APP_URL', value: appUrl }
            { name: 'ENTRA_ALLOWED_TENANTS', value: entraAllowedTenants }
            { name: 'ENTRA_CLIENT_ID', value: entraClientId }
            { name: 'ENTRA_CLIENT_SECRET', secretRef: 'entra-client-secret' }
          ]
          resources: {
            cpu: any('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Startup'
              tcpSocket: { port: 3000 }
              initialDelaySeconds: 5
              periodSeconds: 5
              failureThreshold: 10
            }
            {
              type: 'Readiness'
              tcpSocket: { port: 3000 }
              periodSeconds: 10
            }
            {
              type: 'Liveness'
              tcpSocket: { port: 3000 }
              initialDelaySeconds: 20
              periodSeconds: 20
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = {
  name: workerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: identityMap
  }
  properties: {
    environmentId: environmentResourceId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: imageRegistry
      secrets: [
        {
          name: 'database-url'
          keyVaultUrl: '${secretBase}/${databaseUrlSecretName}'
          identity: userAssignedIdentityResourceId
        }
        {
          name: 'graph-client-secret'
          keyVaultUrl: '${secretBase}/${graphClientSecretName}'
          identity: userAssignedIdentityResourceId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: image
          command: ['node']
          args: ['--conditions=react-server', '--import', 'tsx', 'src/worker.ts']
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'AZURE_STORAGE_ACCOUNT_URL', value: 'https://${storageAccountName}.blob.core.windows.net' }
            { name: 'AZURE_EXPORT_CONTAINER', value: exportContainerName }
            { name: 'AZURE_CLIENT_ID', value: userAssignedIdentityClientId }
            { name: 'GRAPH_CLIENT_ID', value: graphClientId }
            { name: 'GRAPH_CLIENT_SECRET', secretRef: 'graph-client-secret' }
          ]
          resources: {
            cpu: any('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      terminationGracePeriodSeconds: 60
    }
  }
}

output webContainerAppId string = web.id
output workerContainerAppId string = worker.id
output referencedPostgresServerId string = postgresServerResourceId
output referencedBlobStorageAccountId string = blobStorageAccountResourceId
