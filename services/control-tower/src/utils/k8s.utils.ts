/**
 * Utility functions for Kubernetes resource naming
 */

/**
 * Sanitizes a name for use as a Kubernetes resource name.
 * Kubernetes resource names must be:
 * - DNS subdomain compliant (RFC 1123)
 * - Lowercase alphanumeric characters or '-'
 * - Must start and end with alphanumeric
 * - Max 63 characters
 *
 * @param name The original name to sanitize
 * @returns A sanitized name suitable for Kubernetes resources
 */
export function sanitizeK8sName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '') // Remove leading/trailing dashes
    .substring(0, 63)
    .replace(/-+$/, ''); // Ensure it doesn't end with dash after truncation
}
