-- MySQL schema for cross-engine testing
-- Mirrors a subset of the Dokkimi schema for DB proxy / cross-engine scenarios

CREATE TABLE IF NOT EXISTS audit_log (
  id VARCHAR(36) PRIMARY KEY,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(36) NOT NULL,
  actor_id VARCHAR(36),
  details JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_registry (
  id VARCHAR(36) PRIMARY KEY,
  service_name VARCHAR(100) UNIQUE NOT NULL,
  service_url VARCHAR(500) NOT NULL,
  health_status VARCHAR(20) DEFAULT 'UNKNOWN',
  last_heartbeat TIMESTAMP,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Seed data
INSERT INTO service_registry (id, service_name, service_url, health_status) VALUES
  ('svc-ct', 'control-tower', 'http://control-tower:19001', 'HEALTHY'),
  ('svc-lps', 'log-processor-service', 'http://log-processor-service:19002', 'HEALTHY'),
  ('svc-tvs', 'test-validation-service', 'http://test-validation-service:19003', 'HEALTHY');

INSERT INTO audit_log (id, action, entity_type, entity_id, actor_id, details) VALUES
  ('audit-1', 'CREATE', 'PROJECT', 'proj-1', 'user-1', '{"name": "e2e-test-project"}');
