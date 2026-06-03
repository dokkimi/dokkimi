-- Rename k8sNamespace to dockerNetwork on namespace_instances
ALTER TABLE namespace_instances RENAME COLUMN "k8sNamespace" TO "dockerNetwork";

-- Rename k8sName to containerName on instance_items
ALTER TABLE instance_items RENAME COLUMN "k8sName" TO "containerName";
