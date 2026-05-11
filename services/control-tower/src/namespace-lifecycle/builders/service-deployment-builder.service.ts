import { Injectable } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { getConfig, buildServiceUrl } from '@dokkimi/config';
import { DOKKIMI_IMAGES } from '../../constants/image-tags';
import {
  ItemDefinitionLike,
  FLUENT_BIT_RESOURCES,
} from './deployment-builder.types';
import { buildEnvVars, buildResources } from './deployment-builder.utils';

// Java default truststore password — used in both the keytool command and JAVA_TOOL_OPTIONS
const JAVA_TRUSTSTORE_PASSWORD = 'changeit';

@Injectable()
export class ServiceDeploymentBuilderService {
  buildServiceDeployment(
    item: ItemDefinitionLike,
    namespace: string,
    instanceId: string,
    k8sDnsIP: string,
    instanceItemId?: string,
  ): k8s.V1Deployment {
    const deploymentName = item.k8sName;

    return {
      metadata: {
        name: deploymentName,
        namespace,
        labels: {
          app: deploymentName,
        },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: deploymentName,
          },
        },
        template: {
          metadata: {
            labels: {
              app: deploymentName,
              'dokkimi.io/instance-id': instanceId,
            },
          },
          spec: {
            serviceAccountName: 'interceptor-service-account',
            terminationGracePeriodSeconds: 3,
            dnsPolicy: 'None',
            dnsConfig: {
              nameservers: [getConfig().network.dns.nameserver],
              searches: [
                `${namespace}.svc.cluster.local`,
                'svc.cluster.local',
                'cluster.local',
              ],
              options: [
                { name: 'ndots', value: '2' },
                { name: 'timeout', value: '2' },
              ],
            },
            initContainers: [
              {
                name: 'ca-bundle',
                // eclipse-temurin includes keytool for Java truststore support.
                // ~100MB vs ~5MB for alpine:latest — pulled once per node, cached after.
                // Revert to alpine:latest if Java support isn't needed — remove
                // the keytool command and JAVA_TOOL_OPTIONS env var.
                image: 'eclipse-temurin:21-jre-alpine',
                command: [
                  'sh',
                  '-c',
                  // 1. Copy K8s service account files to a writable volume,
                  //    then append the Dokkimi CA so the K8s client trusts both CAs.
                  // 2. Create a combined system CA bundle (for Go, Python, curl).
                  // 3. Create a Java truststore with the Dokkimi CA added.
                  'cp /var/run/secrets/kubernetes.io/serviceaccount/* /sa-combined/ 2>/dev/null || true; ' +
                    'cat /dokkimi-ca/dokkimi-ca.crt >> /sa-combined/ca.crt 2>/dev/null || true; ' +
                    'cp /etc/ssl/certs/ca-certificates.crt /ca-bundle/ca-bundle.crt 2>/dev/null || ' +
                    'cp /etc/pki/tls/certs/ca-bundle.crt /ca-bundle/ca-bundle.crt 2>/dev/null || true; ' +
                    'cat /dokkimi-ca/dokkimi-ca.crt >> /ca-bundle/ca-bundle.crt 2>/dev/null || true; ' +
                    'cp $JAVA_HOME/lib/security/cacerts /ca-bundle/java-cacerts 2>/dev/null || true; ' +
                    'keytool -importcert -noprompt -keystore /ca-bundle/java-cacerts ' +
                    `-storepass ${JAVA_TRUSTSTORE_PASSWORD} -alias dokkimi-ca -file /dokkimi-ca/dokkimi-ca.crt 2>/dev/null || true`,
                ],
                volumeMounts: [
                  {
                    name: 'dokkimi-ca-cert',
                    mountPath: '/dokkimi-ca',
                    readOnly: true,
                  },
                  { name: 'sa-combined', mountPath: '/sa-combined' },
                  { name: 'ca-bundle', mountPath: '/ca-bundle' },
                ],
              },
            ],
            containers: [
              this.buildMainContainer(item, deploymentName),
              this.buildDnsmasqContainer(),
              this.buildFluentBitContainer(item, instanceId, instanceItemId),
            ],
            volumes: [
              {
                name: 'varlog',
                hostPath: { path: '/var/log', type: 'Directory' },
              },
              {
                name: 'docker-containers',
                hostPath: {
                  path: '/var/lib/docker/containers',
                  type: 'DirectoryOrCreate',
                },
              },
              {
                name: 'dnsmasq-config',
                configMap: { name: `dokkimi-dnsmasq-config-${item.k8sName}` },
              },
              {
                name: 'fluent-bit-config',
                configMap: { name: 'dokkimi-interceptor-config' },
              },
              ...(item.localDevPath
                ? [
                    {
                      name: 'local-dev-volume',
                      hostPath: {
                        path: item.localDevPath,
                        type: 'DirectoryOrCreate' as const,
                      },
                    },
                  ]
                : []),
              {
                name: 'dokkimi-ca-cert',
                secret: {
                  secretName: 'dokkimi-ca-cert',
                  optional: true,
                  items: [{ key: 'ca.crt', path: 'dokkimi-ca.crt' }],
                },
              },
              { name: 'sa-combined', emptyDir: {} },
              { name: 'ca-bundle', emptyDir: {} },
            ],
          },
        },
      },
    };
  }

  buildService(item: ItemDefinitionLike, namespace: string): k8s.V1Service {
    const deploymentName = item.k8sName;

    const ports: k8s.V1ServicePort[] = [];

    if (item.port) {
      ports.push({
        port: 80,
        targetPort: item.port,
        name: 'http',
      });
    }

    if (item.debugPort) {
      ports.push({
        port: item.debugPort,
        targetPort: item.debugPort,
        name: 'debug',
      });
    }

    return {
      metadata: { name: deploymentName, namespace },
      spec: {
        selector: { app: deploymentName },
        ports,
      },
    };
  }

  buildDnsmasqConfigMapForService(
    serviceName: string,
    namespace: string,
    allServiceNames: string[],
    interceptorClusterIP: string,
    k8sDnsIP: string,
    databaseNames: string[] = [],
  ): k8s.V1ConfigMap {
    const config = getConfig();
    const dnsNameserver = config.network.dns.nameserver;

    const lines: string[] = [];

    lines.push(`listen-address=${dnsNameserver}`);

    // Infrastructure exceptions - forward to K8s DNS
    lines.push(`server=/host.docker.internal/${k8sDnsIP}`);

    // Database exceptions - forward to K8s DNS (databases use TCP, not HTTP)
    for (const dbName of databaseNames) {
      lines.push(`server=/${dbName}/${k8sDnsIP}`);
      lines.push(
        `server=/${dbName}.${namespace}.svc.cluster.local/${k8sDnsIP}`,
      );
      lines.push(`server=/${dbName}.${namespace}/${k8sDnsIP}`);
      lines.push(`server=/${dbName}.svc.cluster.local/${k8sDnsIP}`);
      lines.push(`server=/${dbName}.cluster.local/${k8sDnsIP}`);
    }

    // Catch-all: route all other domains to interceptor
    lines.push(`address=/#/${interceptorClusterIP}`);

    lines.push('cache-size=1000');
    lines.push('no-hosts');
    lines.push('no-resolv');
    lines.push('log-queries');
    lines.push('log-facility=-');

    return {
      metadata: {
        name: `dokkimi-dnsmasq-config-${serviceName}`,
        namespace,
        labels: {
          'app.kubernetes.io/name': 'dokkimi',
          'app.kubernetes.io/component': 'dnsmasq-config',
        },
      },
      data: {
        'dnsmasq.conf': lines.join('\n'),
      },
    };
  }

  private buildMainContainer(
    item: ItemDefinitionLike,
    deploymentName: string,
  ): k8s.V1Container {
    return {
      name: deploymentName,
      image: item.image!,
      imagePullPolicy: 'IfNotPresent',
      ...((item.port || item.debugPort) && {
        ports: [
          ...(item.port ? [{ containerPort: item.port }] : []),
          ...(item.debugPort
            ? [{ containerPort: item.debugPort, name: 'debug' }]
            : []),
        ],
      }),
      env: [
        // Dokkimi CA trust vars (defaults — user env vars below can override)
        // Node.js: appends to system CA store
        { name: 'NODE_EXTRA_CA_CERTS', value: '/etc/ssl/certs/dokkimi-ca.crt' },
        // Go, Python, curl, and most OpenSSL-based apps: combined system + Dokkimi CA
        { name: 'SSL_CERT_FILE', value: '/ca-bundle/ca-bundle.crt' },
        { name: 'REQUESTS_CA_BUNDLE', value: '/ca-bundle/ca-bundle.crt' },
        { name: 'CURL_CA_BUNDLE', value: '/ca-bundle/ca-bundle.crt' },
        // Java: custom truststore with Dokkimi CA imported
        {
          name: 'JAVA_TOOL_OPTIONS',
          value:
            '-Djavax.net.ssl.trustStore=/ca-bundle/java-cacerts ' +
            `-Djavax.net.ssl.trustStorePassword=${JAVA_TRUSTSTORE_PASSWORD}`,
        },
        // User-defined env vars last (take precedence over Dokkimi defaults)
        ...buildEnvVars(item.env),
      ],
      ...(item.healthCheck && {
        livenessProbe: {
          httpGet: { path: item.healthCheck, port: item.port || 80 },
          initialDelaySeconds: 30,
          periodSeconds: 10,
        },
        readinessProbe: {
          httpGet: { path: item.healthCheck, port: item.port || 80 },
          initialDelaySeconds: 0,
          periodSeconds: 1,
          successThreshold: 1,
          failureThreshold: 3,
        },
      }),
      volumeMounts: [
        ...(item.localDevPath && item.mountPath
          ? [{ name: 'local-dev-volume', mountPath: item.mountPath }]
          : []),
        {
          name: 'dokkimi-ca-cert',
          mountPath: '/etc/ssl/certs/dokkimi-ca.crt',
          subPath: 'dokkimi-ca.crt',
          readOnly: true,
        },
        {
          name: 'sa-combined',
          mountPath: '/var/run/secrets/kubernetes.io/serviceaccount',
          readOnly: true,
        },
        {
          name: 'ca-bundle',
          mountPath: '/ca-bundle',
          readOnly: true,
        },
      ],
      resources: buildResources(item),
    };
  }

  private buildDnsmasqContainer(): k8s.V1Container {
    return {
      name: 'dnsmasq',
      image: DOKKIMI_IMAGES.dnsmasq,
      imagePullPolicy: 'IfNotPresent',
      args: ['-k'],
      ports: [
        { containerPort: 53, protocol: 'UDP' },
        { containerPort: 53, protocol: 'TCP' },
      ],
      volumeMounts: [
        {
          name: 'dnsmasq-config',
          mountPath: '/etc/dnsmasq.conf',
          subPath: 'dnsmasq.conf',
        },
      ],
      resources: {
        requests: { cpu: '50m', memory: '64Mi' },
        limits: { cpu: '200m', memory: '128Mi' },
      },
    };
  }

  private buildFluentBitContainer(
    item: ItemDefinitionLike,
    instanceId: string,
    instanceItemId?: string,
  ): k8s.V1Container {
    return {
      name: 'fluent-bit',
      image: DOKKIMI_IMAGES.fluentBit,
      imagePullPolicy: 'IfNotPresent',
      env: [
        { name: 'INSTANCE_ID', value: instanceId },
        { name: 'INSTANCE_ITEM_NAME', value: item.name },
        ...(instanceItemId
          ? [{ name: 'INSTANCE_ITEM_ID', value: instanceItemId }]
          : []),
        {
          name: 'POD_NAME',
          valueFrom: { fieldRef: { fieldPath: 'metadata.name' } },
        },
        {
          name: 'CONTROL_TOWER_URL',
          value: buildServiceUrl(getConfig().services.controlTower, true),
        },
      ],
      volumeMounts: [
        { name: 'varlog', mountPath: '/var/log', readOnly: true },
        {
          name: 'docker-containers',
          mountPath: '/var/lib/docker/containers',
          readOnly: true,
        },
        {
          name: 'fluent-bit-config',
          mountPath: '/fluent-bit/etc/fluent-bit.conf',
          subPath: 'fluent-bit.conf',
        },
      ],
      resources: FLUENT_BIT_RESOURCES,
    };
  }
}
