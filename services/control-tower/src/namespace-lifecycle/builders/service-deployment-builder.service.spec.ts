import { Test, TestingModule } from '@nestjs/testing';
import { ServiceDeploymentBuilderService } from './service-deployment-builder.service';
import { getConfig, buildServiceUrl } from '@dokkimi/config';

describe('ServiceDeploymentBuilderService', () => {
  let serviceBuilder: ServiceDeploymentBuilderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ServiceDeploymentBuilderService],
    }).compile();

    serviceBuilder = module.get<ServiceDeploymentBuilderService>(
      ServiceDeploymentBuilderService,
    );
  });

  // ─── helpers ──────────────────────────────────────────────────────

  function makeServiceItem(overrides: Record<string, unknown> = {}) {
    return {
      id: 'item-1',
      name: 'Test Service',
      k8sName: 'test-service',
      type: 'SERVICE' as const,
      description: null,
      image: 'nginx:latest',
      port: 8080,
      debugPort: null,
      healthCheck: null,
      minCpu: null,
      minMemory: null,
      maxCpu: null,
      maxMemory: null,
      env: null,
      database: null,
      initFiles: null,
      uiPath: null,
      localDevPath: null,
      mountPath: null,
      ...overrides,
    };
  }

  // ─── buildServiceDeployment ───────────────────────────────────────

  describe('buildServiceDeployment', () => {
    it('should build a service deployment with all fields', () => {
      const item = makeServiceItem({
        port: 8080,
        healthCheck: '/health',
        minCpu: 0.5,
        minMemory: 512,
        maxCpu: 2,
        maxMemory: 2048,
        env: [{ name: 'ENV_VAR', value: 'test-value' }],
      });

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
        'item-1',
      );

      expect(deployment.metadata!.name).toBe('test-service');
      expect(deployment.metadata!.namespace).toBe('test-namespace');
      expect(deployment.spec!.replicas).toBe(1);

      // 3 containers: main + dnsmasq + fluent-bit
      const containers = deployment.spec!.template.spec!.containers;
      expect(containers).toHaveLength(3);
      expect(containers[0].name).toBe('test-service');
      expect(containers[0].image).toBe('nginx:latest');
      expect(containers[0].ports).toEqual([{ containerPort: 8080 }]);
      expect(containers[0].livenessProbe).toBeDefined();
      expect(containers[0].readinessProbe).toBeDefined();
      expect(containers[0].resources).toEqual({
        requests: { cpu: '0.5', memory: '512Mi' },
        limits: { cpu: '2', memory: '2048Mi' },
      });

      // Env vars
      expect(containers[0].env).toContainEqual({
        name: 'ENV_VAR',
        value: 'test-value',
      });

      // DNS configuration
      expect(deployment.spec!.template.spec!.dnsPolicy).toBe('None');
      expect(deployment.spec!.template.spec!.dnsConfig?.nameservers).toEqual([
        getConfig().network.dns.nameserver,
      ]);
      expect(deployment.spec!.template.spec!.dnsConfig?.searches).toContain(
        'test-namespace.svc.cluster.local',
      );

      // dnsmasq sidecar
      expect(containers[1].name).toBe('dnsmasq');
      expect(containers[1].image).toBe('andyshinn/dnsmasq:2.83');
      expect(containers[1].args).toEqual(['-k']);
      expect(containers[1].ports).toContainEqual({
        containerPort: 53,
        protocol: 'UDP',
      });
      expect(containers[1].volumeMounts).toContainEqual({
        name: 'dnsmasq-config',
        mountPath: '/etc/dnsmasq.conf',
        subPath: 'dnsmasq.conf',
      });

      // fluent-bit sidecar
      expect(containers[2].name).toBe('fluent-bit');
      const fluentBitEnv = containers[2].env;
      expect(fluentBitEnv).toContainEqual({
        name: 'INSTANCE_ID',
        value: 'instance-1',
      });
      expect(fluentBitEnv).toContainEqual({
        name: 'INSTANCE_ITEM_NAME',
        value: 'Test Service',
      });
      expect(fluentBitEnv).toContainEqual({
        name: 'INSTANCE_ITEM_ID',
        value: 'item-1',
      });
      const ctUrl = buildServiceUrl(getConfig().services.controlTower, true);
      expect(fluentBitEnv).toContainEqual({
        name: 'CONTROL_TOWER_URL',
        value: ctUrl,
      });

      // Volumes
      const volumes = deployment.spec!.template.spec!.volumes!;
      expect(volumes).toContainEqual({
        name: 'dnsmasq-config',
        configMap: { name: 'dokkimi-dnsmasq-config-test-service' },
      });
      expect(volumes).toContainEqual({
        name: 'fluent-bit-config',
        configMap: { name: 'dokkimi-interceptor-config' },
      });
    });

    it('should build deployment without optional fields', () => {
      const item = makeServiceItem({
        port: null,
        healthCheck: null,
        env: null,
      });

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const containers = deployment.spec!.template.spec!.containers;
      expect(containers).toHaveLength(3);
      expect(containers[0].ports).toBeUndefined();
      expect(containers[0].livenessProbe).toBeUndefined();
      expect(containers[0].readinessProbe).toBeUndefined();
      expect(containers[0].resources).toEqual({});
    });

    it('should not include INSTANCE_ITEM_ID env when instanceItemId is omitted', () => {
      const item = makeServiceItem();

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const fluentBitEnv = deployment.spec!.template.spec!.containers[2].env!;
      const instanceItemIdEnv = fluentBitEnv.find(
        (e) => e.name === 'INSTANCE_ITEM_ID',
      );
      expect(instanceItemIdEnv).toBeUndefined();
    });

    it('should use k8sName for deployment name', () => {
      const item = makeServiceItem({
        name: 'My Test Service!',
        k8sName: 'my-test-service',
      });

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      expect(deployment.metadata!.name).toBe('my-test-service');
      expect(deployment.spec!.template.spec!.containers).toHaveLength(3);
    });

    it('should include debug port when set', () => {
      const item = makeServiceItem({ port: 8080, debugPort: 9229 });

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      expect(deployment.spec!.template.spec!.containers[0].ports).toEqual([
        { containerPort: 8080 },
        { containerPort: 9229, name: 'debug' },
      ]);
    });

    it('should include only debug port when main port is null', () => {
      const item = makeServiceItem({ port: null, debugPort: 9229 });

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      expect(deployment.spec!.template.spec!.containers[0].ports).toEqual([
        { containerPort: 9229, name: 'debug' },
      ]);
    });

    it('should add volume mount when localDevPath and mountPath are set', () => {
      const item = makeServiceItem({
        localDevPath: '/Users/me/my-app',
        mountPath: '/app/src',
      });

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const mainContainer = deployment.spec!.template.spec!.containers[0];
      expect(mainContainer.volumeMounts).toContainEqual({
        name: 'local-dev-volume',
        mountPath: '/app/src',
      });

      const volumes = deployment.spec!.template.spec!.volumes || [];
      const localDevVolume = volumes.find((v) => v.name === 'local-dev-volume');
      expect(localDevVolume?.hostPath?.path).toBe('/Users/me/my-app');
      expect(localDevVolume?.hostPath?.type).toBe('DirectoryOrCreate');
    });

    it('should not add volume mount when localDevPath is not set', () => {
      const item = makeServiceItem({
        localDevPath: null,
        mountPath: '/app/src',
      });

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const mainContainer = deployment.spec!.template.spec!.containers[0];
      const localDevMount = (mainContainer.volumeMounts || []).find(
        (vm) => vm.name === 'local-dev-volume',
      );
      expect(localDevMount).toBeUndefined();

      const volumes = deployment.spec!.template.spec!.volumes || [];
      expect(
        volumes.find((v) => v.name === 'local-dev-volume'),
      ).toBeUndefined();
    });

    it('should handle object-format env vars', () => {
      const item = makeServiceItem({
        env: { DB_HOST: 'localhost', DB_PORT: '5432' },
      });

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const envVars = deployment.spec!.template.spec!.containers[0].env!;
      expect(envVars).toContainEqual({ name: 'DB_HOST', value: 'localhost' });
      expect(envVars).toContainEqual({ name: 'DB_PORT', value: '5432' });
    });

    it('should handle array-format env vars with name/value objects', () => {
      const item = makeServiceItem({
        env: [
          { name: 'FOO', value: 'bar' },
          { name: 'NUM', value: 42 },
          { name: 'BOOL', value: true },
        ],
      });

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const envVars = deployment.spec!.template.spec!.containers[0].env!;
      expect(envVars).toContainEqual({ name: 'FOO', value: 'bar' });
      expect(envVars).toContainEqual({ name: 'NUM', value: '42' });
      expect(envVars).toContainEqual({ name: 'BOOL', value: 'true' });
    });

    it('should skip array env vars with missing name', () => {
      const item = makeServiceItem({
        env: [
          { name: '', value: 'bar' },
          { name: null, value: 'baz' },
          { value: 'no-name' },
          { name: 'VALID', value: 'ok' },
        ],
      });

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const envVars = deployment.spec!.template.spec!.containers[0].env!;
      expect(envVars).toContainEqual({ name: 'VALID', value: 'ok' });
    });

    it('should handle healthCheck with default port', () => {
      const item = makeServiceItem({
        port: null,
        healthCheck: '/ready',
      });

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const mainContainer = deployment.spec!.template.spec!.containers[0];
      expect(mainContainer.livenessProbe?.httpGet?.port).toBe(80);
      expect(mainContainer.readinessProbe?.httpGet?.port).toBe(80);
    });

    it('should set instance-id label on pod template', () => {
      const item = makeServiceItem();

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'my-instance-42',
        '10.96.0.10',
      );

      const podLabels = deployment.spec!.template.metadata!.labels!;
      expect(podLabels['dokkimi.io/instance-id']).toBe('my-instance-42');
      expect(podLabels['app']).toBe('test-service');
    });

    it('should set serviceAccountName and terminationGracePeriodSeconds', () => {
      const item = makeServiceItem();

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const podSpec = deployment.spec!.template.spec!;
      expect(podSpec.serviceAccountName).toBe('interceptor-service-account');
      expect(podSpec.terminationGracePeriodSeconds).toBe(3);
    });

    it('should include DNS config options (ndots and timeout)', () => {
      const item = makeServiceItem();

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const dnsConfig = deployment.spec!.template.spec!.dnsConfig!;
      expect(dnsConfig.options).toEqual([
        { name: 'ndots', value: '2' },
        { name: 'timeout', value: '2' },
      ]);
    });

    it('should include ca-bundle init container', () => {
      const item = makeServiceItem();

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const initContainers = deployment.spec!.template.spec!.initContainers!;
      expect(initContainers).toHaveLength(1);
      expect(initContainers[0].name).toBe('ca-bundle');
      expect(initContainers[0].image).toBe('eclipse-temurin:21-jre-alpine');
      expect(initContainers[0].volumeMounts).toEqual([
        { name: 'dokkimi-ca-cert', mountPath: '/dokkimi-ca', readOnly: true },
        { name: 'sa-combined', mountPath: '/sa-combined' },
        { name: 'ca-bundle', mountPath: '/ca-bundle' },
      ]);
    });

    it('should include CA trust env vars before user env vars', () => {
      const item = makeServiceItem({
        env: [{ name: 'MY_VAR', value: 'my-value' }],
      });

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const envVars = deployment.spec!.template.spec!.containers[0].env!;
      const caEnvNames = [
        'NODE_EXTRA_CA_CERTS',
        'SSL_CERT_FILE',
        'REQUESTS_CA_BUNDLE',
        'CURL_CA_BUNDLE',
        'JAVA_TOOL_OPTIONS',
      ];

      // All CA env vars should be present
      for (const name of caEnvNames) {
        expect(envVars.find((e) => e.name === name)).toBeDefined();
      }

      // CA vars should appear before user vars
      const lastCaIndex = Math.max(
        ...caEnvNames.map((n) => envVars.findIndex((e) => e.name === n)),
      );
      const userVarIndex = envVars.findIndex((e) => e.name === 'MY_VAR');
      expect(lastCaIndex).toBeLessThan(userVarIndex);
    });

    it('should set correct JAVA_TOOL_OPTIONS value', () => {
      const item = makeServiceItem();

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const envVars = deployment.spec!.template.spec!.containers[0].env!;
      const javaOpts = envVars.find((e) => e.name === 'JAVA_TOOL_OPTIONS');
      expect(javaOpts!.value).toBe(
        '-Djavax.net.ssl.trustStore=/ca-bundle/java-cacerts ' +
          '-Djavax.net.ssl.trustStorePassword=changeit',
      );
    });

    it('should not add local-dev volume mount when localDevPath set but mountPath is null', () => {
      const item = makeServiceItem({
        localDevPath: '/Users/me/app',
        mountPath: null,
      });

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const mainContainer = deployment.spec!.template.spec!.containers[0];
      const localDevMount = (mainContainer.volumeMounts || []).find(
        (vm) => vm.name === 'local-dev-volume',
      );
      expect(localDevMount).toBeUndefined();
    });

    it('should include dokkimi-ca-cert, sa-combined, and ca-bundle volumes', () => {
      const item = makeServiceItem();

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const volumes = deployment.spec!.template.spec!.volumes!;

      const caCert = volumes.find((v) => v.name === 'dokkimi-ca-cert');
      expect(caCert).toEqual({
        name: 'dokkimi-ca-cert',
        secret: {
          secretName: 'dokkimi-ca-cert',
          optional: true,
          items: [{ key: 'ca.crt', path: 'dokkimi-ca.crt' }],
        },
      });

      expect(volumes).toContainEqual({ name: 'sa-combined', emptyDir: {} });
      expect(volumes).toContainEqual({ name: 'ca-bundle', emptyDir: {} });
    });

    it('should mount dokkimi-ca-cert, sa-combined, and ca-bundle in main container', () => {
      const item = makeServiceItem();

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const mounts =
        deployment.spec!.template.spec!.containers[0].volumeMounts!;

      expect(mounts).toContainEqual({
        name: 'dokkimi-ca-cert',
        mountPath: '/etc/ssl/certs/dokkimi-ca.crt',
        subPath: 'dokkimi-ca.crt',
        readOnly: true,
      });
      expect(mounts).toContainEqual({
        name: 'sa-combined',
        mountPath: '/var/run/secrets/kubernetes.io/serviceaccount',
        readOnly: true,
      });
      expect(mounts).toContainEqual({
        name: 'ca-bundle',
        mountPath: '/ca-bundle',
        readOnly: true,
      });
    });

    it('should set liveness probe with correct timing config', () => {
      const item = makeServiceItem({
        port: 3000,
        healthCheck: '/healthz',
      });

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const mainContainer = deployment.spec!.template.spec!.containers[0];
      expect(mainContainer.livenessProbe).toEqual({
        httpGet: { path: '/healthz', port: 3000 },
        initialDelaySeconds: 30,
        periodSeconds: 10,
      });
      expect(mainContainer.readinessProbe).toEqual({
        httpGet: { path: '/healthz', port: 3000 },
        initialDelaySeconds: 0,
        periodSeconds: 1,
        successThreshold: 1,
        failureThreshold: 3,
      });
    });

    it('should configure fluent-bit container with correct volume mounts and resources', () => {
      const item = makeServiceItem();

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const fluentBit = deployment.spec!.template.spec!.containers[2];
      expect(fluentBit.image).toBe('fluent/fluent-bit:3.2');
      expect(fluentBit.volumeMounts).toEqual([
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
      ]);
      expect(fluentBit.resources).toEqual({
        requests: { cpu: '50m', memory: '64Mi' },
        limits: { cpu: '200m', memory: '128Mi' },
      });
    });

    it('should include POD_NAME env var using fieldRef in fluent-bit', () => {
      const item = makeServiceItem();

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const fluentBitEnv = deployment.spec!.template.spec!.containers[2].env!;
      expect(fluentBitEnv).toContainEqual({
        name: 'POD_NAME',
        valueFrom: { fieldRef: { fieldPath: 'metadata.name' } },
      });
    });

    it('should set imagePullPolicy to IfNotPresent on all containers', () => {
      const item = makeServiceItem();

      const deployment = serviceBuilder.buildServiceDeployment(
        item,
        'test-namespace',
        'instance-1',
        '10.96.0.10',
      );

      const containers = deployment.spec!.template.spec!.containers;
      for (const container of containers) {
        expect(container.imagePullPolicy).toBe('IfNotPresent');
      }
    });
  });

  // ─── buildService ─────────────────────────────────────────────────

  describe('buildService', () => {
    it('should build a service with http port mapped to 80', () => {
      const item = makeServiceItem({ port: 8080 });

      const k8sService = serviceBuilder.buildService(item, 'test-namespace');

      expect(k8sService.metadata!.name).toBe('test-service');
      expect(k8sService.spec!.ports).toEqual([
        { port: 80, targetPort: 8080, name: 'http' },
      ]);
    });

    it('should build a service without port', () => {
      const item = makeServiceItem({ port: null });

      const k8sService = serviceBuilder.buildService(item, 'test-namespace');

      expect(k8sService.spec!.ports).toEqual([]);
    });

    it('should include debug port when set', () => {
      const item = makeServiceItem({ port: 8080, debugPort: 9229 });

      const k8sService = serviceBuilder.buildService(item, 'test-namespace');

      expect(k8sService.spec!.ports).toEqual([
        { port: 80, targetPort: 8080, name: 'http' },
        { port: 9229, targetPort: 9229, name: 'debug' },
      ]);
    });

    it('should include only debug port when main port is null', () => {
      const item = makeServiceItem({ port: null, debugPort: 9229 });

      const k8sService = serviceBuilder.buildService(item, 'test-namespace');

      expect(k8sService.spec!.ports).toEqual([
        { port: 9229, targetPort: 9229, name: 'debug' },
      ]);
    });
  });

  // ─── buildDnsmasqConfigMapForService ──────────────────────────────

  describe('buildDnsmasqConfigMapForService', () => {
    it('should build a dnsmasq config with no databases', () => {
      const cm = serviceBuilder.buildDnsmasqConfigMapForService(
        'my-svc',
        'dokkimi-ns',
        ['my-svc', 'other-svc'],
        '10.0.0.5',
        '10.96.0.10',
      );

      expect(cm.metadata!.name).toBe('dokkimi-dnsmasq-config-my-svc');
      expect(cm.metadata!.namespace).toBe('dokkimi-ns');

      const conf = cm.data!['dnsmasq.conf'];
      expect(conf).toContain('address=/#/10.0.0.5');
      expect(conf).toContain('server=/host.docker.internal/10.96.0.10');
      expect(conf).toContain('cache-size=1000');
      expect(conf).toContain('no-hosts');
      expect(conf).toContain('no-resolv');
      expect(conf).toContain('log-queries');
    });

    it('should add database DNS exceptions', () => {
      const cm = serviceBuilder.buildDnsmasqConfigMapForService(
        'my-svc',
        'dokkimi-ns',
        ['my-svc'],
        '10.0.0.5',
        '10.96.0.10',
        ['postgres-db', 'redis-cache'],
      );

      const conf = cm.data!['dnsmasq.conf'];
      expect(conf).toContain('server=/postgres-db/10.96.0.10');
      expect(conf).toContain('server=/redis-cache/10.96.0.10');
      expect(conf).toContain(
        'server=/postgres-db.dokkimi-ns.svc.cluster.local/10.96.0.10',
      );
      expect(conf).toContain('server=/postgres-db.dokkimi-ns/10.96.0.10');
      expect(conf).toContain(
        'server=/postgres-db.svc.cluster.local/10.96.0.10',
      );
      expect(conf).toContain('server=/postgres-db.cluster.local/10.96.0.10');
    });

    it('should have correct labels', () => {
      const cm = serviceBuilder.buildDnsmasqConfigMapForService(
        'svc',
        'ns',
        ['svc'],
        '10.0.0.1',
        '10.96.0.10',
      );

      expect(cm.metadata!.labels).toEqual({
        'app.kubernetes.io/name': 'dokkimi',
        'app.kubernetes.io/component': 'dnsmasq-config',
      });
    });

    it('should use config nameserver for listen-address', () => {
      const cm = serviceBuilder.buildDnsmasqConfigMapForService(
        'svc',
        'ns',
        ['svc'],
        '10.0.0.1',
        '10.96.0.10',
      );

      const conf = cm.data!['dnsmasq.conf'];
      const config = getConfig();
      expect(conf).toContain(`listen-address=${config.network.dns.nameserver}`);
    });

    it('should include log-facility=- directive', () => {
      const cm = serviceBuilder.buildDnsmasqConfigMapForService(
        'svc',
        'ns',
        ['svc'],
        '10.0.0.1',
        '10.96.0.10',
      );

      const conf = cm.data!['dnsmasq.conf'];
      expect(conf).toContain('log-facility=-');
    });

    it('should generate all five DNS exception variants per database', () => {
      const cm = serviceBuilder.buildDnsmasqConfigMapForService(
        'api',
        'my-ns',
        ['api'],
        '10.0.0.5',
        '10.96.0.10',
        ['my-db'],
      );

      const conf = cm.data!['dnsmasq.conf'];
      expect(conf).toContain('server=/my-db/10.96.0.10');
      expect(conf).toContain(
        'server=/my-db.my-ns.svc.cluster.local/10.96.0.10',
      );
      expect(conf).toContain('server=/my-db.my-ns/10.96.0.10');
      expect(conf).toContain('server=/my-db.svc.cluster.local/10.96.0.10');
      expect(conf).toContain('server=/my-db.cluster.local/10.96.0.10');
    });

    it('should default databaseNames to empty array', () => {
      const cm = serviceBuilder.buildDnsmasqConfigMapForService(
        'svc',
        'ns',
        ['svc'],
        '10.0.0.1',
        '10.96.0.10',
      );

      const conf = cm.data!['dnsmasq.conf'];
      // Should not contain any server=/ lines other than host.docker.internal
      const serverLines = conf
        .split('\n')
        .filter((l: string) => l.startsWith('server=/'));
      expect(serverLines).toEqual(['server=/host.docker.internal/10.96.0.10']);
    });
  });
});
