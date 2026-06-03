-- Enums
CREATE TYPE public."InstanceStatus" AS ENUM (
    'PENDING',
    'STARTING',
    'RUNNING',
    'STOPPING',
    'TERMINATING',
    'STOPPED',
    'FAILED'
);
CREATE TYPE public."ItemStatus" AS ENUM (
    'PENDING',
    'STARTING',
    'RUNNING',
    'STOPPING',
    'STOPPED',
    'CRASHED'
);
CREATE TYPE public."TestStatus" AS ENUM (
    'PENDING',
    'RUNNING',
    'PASSED',
    'FAILED',
    'CANCELLED'
);
CREATE TYPE public."ReadinessStatus" AS ENUM (
    'READY',
    'NOT_READY',
    'UNKNOWN'
);
CREATE TYPE public."LogLevel" AS ENUM (
    'INFO',
    'WARN',
    'ERROR',
    'DEBUG'
);
CREATE TYPE public."RunStatus" AS ENUM (
    'PENDING',
    'RUNNING',
    'COMPLETED',
    'FAILED',
    'CANCELLED'
);

-- Tables
CREATE TABLE public.runs (
    id text NOT NULL,
    status public."RunStatus" DEFAULT 'PENDING'::public."RunStatus" NOT NULL,
    "projectPath" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) without time zone,
    "cancelledAt" timestamp(3) without time zone
);
CREATE TABLE public.namespace_instances (
    id text NOT NULL,
    name text NOT NULL,
    status public."InstanceStatus" DEFAULT 'PENDING'::public."InstanceStatus" NOT NULL,
    "dockerNetwork" text,
    "startedAt" timestamp(3) without time zone,
    "stoppedAt" timestamp(3) without time zone,
    "testStatus" public."TestStatus",
    "testResults" jsonb,
    "testCompletedAt" timestamp(3) without time zone,
    "errorMessage" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "runId" text
);
CREATE TABLE public.instance_items (
    id text NOT NULL,
    "instanceId" text NOT NULL,
    "itemDefinitionName" text NOT NULL,
    status public."ItemStatus" DEFAULT 'PENDING'::public."ItemStatus" NOT NULL,
    "readinessStatus" public."ReadinessStatus" DEFAULT 'UNKNOWN'::public."ReadinessStatus" NOT NULL,
    "readinessLastChecked" timestamp(3) without time zone,
    "containerName" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);
CREATE TABLE public.http_logs (
    id text NOT NULL,
    "instanceId" text,
    "instanceItemId" text,
    method text NOT NULL,
    url text NOT NULL,
    "statusCode" integer,
    "requestBody" jsonb,
    "responseBody" jsonb,
    "requestHeaders" jsonb,
    "responseHeaders" jsonb,
    origin text,
    target text,
    "targetId" text,
    "isMocked" boolean,
    "requestSentAt" timestamp(3) without time zone,
    "responseReceivedAt" timestamp(3) without time zone,
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.console_logs (
    id text NOT NULL,
    "instanceId" text,
    "instanceItemId" text,
    level public."LogLevel" NOT NULL,
    message text NOT NULL,
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.database_logs (
    id text NOT NULL,
    "instanceId" text,
    "instanceItemId" text,
    "databaseType" text NOT NULL,
    "databaseName" text NOT NULL,
    query text NOT NULL,
    params jsonb,
    success boolean NOT NULL,
    data jsonb,
    "rowsAffected" integer,
    error text,
    duration integer,
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.test_execution_logs (
    id text NOT NULL,
    "instanceId" text NOT NULL,
    "eventType" text NOT NULL,
    message text NOT NULL,
    "stepIndex" integer,
    "subActionIndex" integer,
    "subStepIndex" integer,
    "actionType" text,
    selector text,
    duration integer,
    error text,
    "errorType" text,
    variables jsonb DEFAULT '{}'::jsonb NOT NULL,
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.artifacts (
    id text NOT NULL,
    "instanceId" text NOT NULL,
    "stepIndex" integer NOT NULL,
    "subStepIndex" integer NOT NULL,
    type text NOT NULL,
    name text,
    uri text NOT NULL,
    verdict text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE public.assertion_results (
    id text NOT NULL,
    "instanceId" text NOT NULL,
    "requestId" text,
    "stepIndex" integer NOT NULL,
    "assertionIndex" integer NOT NULL,
    "assertionType" text NOT NULL,
    passed boolean NOT NULL,
    expected jsonb,
    actual jsonb,
    error text,
    path text,
    operator text,
    "blockIndex" integer,
    "resultKind" text,
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Primary keys
ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.namespace_instances
    ADD CONSTRAINT namespace_instances_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.instance_items
    ADD CONSTRAINT instance_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.http_logs
    ADD CONSTRAINT http_logs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.console_logs
    ADD CONSTRAINT console_logs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.database_logs
    ADD CONSTRAINT database_logs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.test_execution_logs
    ADD CONSTRAINT test_execution_logs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.assertion_results
    ADD CONSTRAINT assertion_results_pkey PRIMARY KEY (id);

-- Indexes: runs
CREATE INDEX runs_status_idx ON public.runs USING btree (status);
CREATE INDEX "runs_projectPath_idx" ON public.runs USING btree ("projectPath");

-- Indexes: namespace_instances
CREATE INDEX "namespace_instances_runId_idx" ON public.namespace_instances USING btree ("runId");
CREATE INDEX namespace_instances_status_idx ON public.namespace_instances USING btree (status);
CREATE INDEX "namespace_instances_testStatus_idx" ON public.namespace_instances USING btree ("testStatus");
CREATE INDEX "namespace_instances_createdAt_idx" ON public.namespace_instances USING btree ("createdAt");

-- Indexes: instance_items
CREATE INDEX "instance_items_instanceId_idx" ON public.instance_items USING btree ("instanceId");
CREATE INDEX "instance_items_itemDefinitionName_idx" ON public.instance_items USING btree ("itemDefinitionName");
CREATE INDEX instance_items_status_idx ON public.instance_items USING btree (status);

-- Indexes: http_logs
CREATE INDEX "http_logs_instanceId_idx" ON public.http_logs USING btree ("instanceId");
CREATE INDEX "http_logs_instanceItemId_idx" ON public.http_logs USING btree ("instanceItemId");
CREATE INDEX http_logs_timestamp_idx ON public.http_logs USING btree ("timestamp");
CREATE INDEX "http_logs_instanceId_timestamp_idx" ON public.http_logs USING btree ("instanceId", "timestamp");
CREATE INDEX http_logs_origin_target_idx ON public.http_logs USING btree (origin, target);
CREATE INDEX "http_logs_isMocked_idx" ON public.http_logs USING btree ("isMocked");

-- Indexes: console_logs
CREATE INDEX "console_logs_instanceId_idx" ON public.console_logs USING btree ("instanceId");
CREATE INDEX "console_logs_instanceItemId_idx" ON public.console_logs USING btree ("instanceItemId");
CREATE INDEX console_logs_timestamp_idx ON public.console_logs USING btree ("timestamp");
CREATE INDEX console_logs_level_idx ON public.console_logs USING btree (level);

-- Indexes: database_logs
CREATE INDEX "database_logs_instanceId_idx" ON public.database_logs USING btree ("instanceId");
CREATE INDEX "database_logs_instanceItemId_idx" ON public.database_logs USING btree ("instanceItemId");
CREATE INDEX "database_logs_databaseName_idx" ON public.database_logs USING btree ("databaseName");
CREATE INDEX database_logs_timestamp_idx ON public.database_logs USING btree ("timestamp");
CREATE INDEX "database_logs_databaseType_idx" ON public.database_logs USING btree ("databaseType");

-- Indexes: test_execution_logs
CREATE INDEX "test_execution_logs_instanceId_idx" ON public.test_execution_logs USING btree ("instanceId");
CREATE INDEX "test_execution_logs_eventType_idx" ON public.test_execution_logs USING btree ("eventType");
CREATE INDEX test_execution_logs_timestamp_idx ON public.test_execution_logs USING btree ("timestamp");
CREATE INDEX "test_execution_logs_stepIndex_subActionIndex_idx" ON public.test_execution_logs USING btree ("stepIndex", "subActionIndex");
CREATE INDEX "test_execution_logs_instanceId_timestamp_idx" ON public.test_execution_logs USING btree ("instanceId", "timestamp");

-- Indexes: artifacts
CREATE INDEX "artifacts_instanceId_idx" ON public.artifacts USING btree ("instanceId");
CREATE INDEX "artifacts_instanceId_type_idx" ON public.artifacts USING btree ("instanceId", type);
CREATE INDEX "artifacts_instanceId_verdict_idx" ON public.artifacts USING btree ("instanceId", verdict);

-- Indexes: assertion_results
CREATE INDEX "assertion_results_instanceId_idx" ON public.assertion_results USING btree ("instanceId");

-- Foreign keys
ALTER TABLE ONLY public.namespace_instances
    ADD CONSTRAINT "namespace_instances_runId_fkey" FOREIGN KEY ("runId") REFERENCES public.runs(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.instance_items
    ADD CONSTRAINT "instance_items_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES public.namespace_instances(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.http_logs
    ADD CONSTRAINT "http_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES public.namespace_instances(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.console_logs
    ADD CONSTRAINT "console_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES public.namespace_instances(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.database_logs
    ADD CONSTRAINT "database_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES public.namespace_instances(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.test_execution_logs
    ADD CONSTRAINT "test_execution_logs_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES public.namespace_instances(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT "artifacts_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES public.namespace_instances(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE ONLY public.assertion_results
    ADD CONSTRAINT "assertion_results_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES public.namespace_instances(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Prisma migrations marker (CT verifySchema checks for this table)
CREATE TABLE public._prisma_migrations (
    id text NOT NULL PRIMARY KEY,
    checksum text NOT NULL,
    finished_at timestamp with time zone,
    migration_name text NOT NULL,
    logs text,
    rolled_back_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_steps_count integer DEFAULT 0 NOT NULL
);
INSERT INTO public._prisma_migrations (id, checksum, migration_name, finished_at)
    VALUES ('init', 'init-schema-sql', 'init_from_schema_sql', NOW());

-- Seed data for integration tests
INSERT INTO namespace_instances (id, name, status, "createdAt", "updatedAt")
    VALUES ('inst-1', 'test-instance', 'RUNNING', NOW(), NOW());
INSERT INTO instance_items (id, "instanceId", "itemDefinitionName", status, "createdAt", "updatedAt")
    VALUES ('inst-item-1', 'inst-1', 'my-service', 'RUNNING', NOW(), NOW());
