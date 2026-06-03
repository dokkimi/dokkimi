-- Rename k8sNamespace to dockerNetwork on namespace_instances
ALTER TABLE public.namespace_instances RENAME COLUMN "k8sNamespace" TO "dockerNetwork";

-- Rename k8sName to containerName on instance_items
ALTER TABLE public.instance_items RENAME COLUMN "k8sName" TO "containerName";
