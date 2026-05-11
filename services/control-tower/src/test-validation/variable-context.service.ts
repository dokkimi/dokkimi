import { Injectable } from '@nestjs/common';

/**
 * Service for managing variable extraction and interpolation
 *
 * Variable Scope (per design document):
 * - Variables are scoped to the test run (cross-group)
 * - Variables extracted in group N are available in groups N+1, N+2, etc.
 * - Variables do NOT persist across separate test runs
 * - Within a group (parallel execution), variable extraction order is non-deterministic
 *
 * Variable Syntax:
 * - Use {{variableName}} for interpolation
 * - Escape literal {{ with \{\{
 * - Undefined variables cause immediate error (fail-fast)
 */
@Injectable()
export class VariableContextService {
  private variables: Map<string, any> = new Map();

  /**
   * Sets a variable directly (for seeding hardcoded variables from TestDefinition.variables)
   */
  set(name: string, value: any): void {
    this.variables.set(name, value);
  }

  /**
   * Resolves variables in a template string using {{variableName}} syntax
   */
  resolve(template: string): string {
    // Handle escape sequence: \{\{ becomes literal {{
    let result = template.replace(/\\\{\\\{/g, '{{ESCAPED_OPEN}}');
    result = result.replace(/\\\}\}/g, '{{ESCAPED_CLOSE}}');

    // Replace variables - FAIL if undefined
    result = result.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
      const value = this.variables.get(varName);
      if (value === undefined) {
        const availableVars = [...this.variables.keys()].join(', ') || 'none';
        throw new Error(
          `Variable '${varName}' is not defined. Available variables: ${availableVars}`,
        );
      }
      return String(value);
    });

    // Restore escaped sequences
    result = result.replace(/\{\{ESCAPED_OPEN\}\}/g, '{{');
    result = result.replace(/\{\{ESCAPED_CLOSE\}\}/g, '}}');

    return result;
  }

  /**
   * Resolves variables in an object (recursively)
   */
  resolveObject(obj: any): any {
    if (typeof obj === 'string') {
      return this.resolve(obj);
    } else if (Array.isArray(obj)) {
      return obj.map((item) => this.resolveObject(item));
    } else if (obj !== null && typeof obj === 'object') {
      const resolved: any = {};
      for (const [key, value] of Object.entries(obj)) {
        resolved[key] = this.resolveObject(value);
      }
      return resolved;
    }
    return obj;
  }

  /**
   * Gets a variable value
   */
  get(variable: string): any {
    return this.variables.get(variable);
  }

  /**
   * Clears all variables (for new test run)
   * Called at the start of each test run to ensure clean variable context
   */
  clear(): void {
    this.variables.clear();
  }
}
