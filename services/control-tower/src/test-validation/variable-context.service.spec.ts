import { VariableContextService } from './variable-context.service';

describe('VariableContextService', () => {
  let service: VariableContextService;

  beforeEach(() => {
    service = new VariableContextService();
  });

  describe('set / get', () => {
    it('should store and retrieve a string value', () => {
      service.set('name', 'World');
      expect(service.get('name')).toBe('World');
    });

    it('should store and retrieve a numeric value', () => {
      service.set('count', 42);
      expect(service.get('count')).toBe(42);
    });

    it('should store and retrieve an object value', () => {
      const obj = { foo: 'bar' };
      service.set('data', obj);
      expect(service.get('data')).toBe(obj);
    });

    it('should store and retrieve an array value', () => {
      const arr = [1, 2, 3];
      service.set('items', arr);
      expect(service.get('items')).toBe(arr);
    });

    it('should return undefined for unset variables', () => {
      expect(service.get('missing')).toBeUndefined();
    });

    it('should overwrite an existing variable', () => {
      service.set('x', 'old');
      service.set('x', 'new');
      expect(service.get('x')).toBe('new');
    });
  });

  describe('resolve', () => {
    it('should replace a single variable', () => {
      service.set('name', 'World');
      expect(service.resolve('Hello {{name}}')).toBe('Hello World');
    });

    it('should replace multiple different variables', () => {
      service.set('greeting', 'Hi');
      service.set('name', 'Alice');
      expect(service.resolve('{{greeting}} {{name}}!')).toBe('Hi Alice!');
    });

    it('should replace the same variable used twice', () => {
      service.set('x', 'ab');
      expect(service.resolve('{{x}}-{{x}}')).toBe('ab-ab');
    });

    it('should convert numeric values to strings', () => {
      service.set('port', 8080);
      expect(service.resolve('http://localhost:{{port}}')).toBe(
        'http://localhost:8080',
      );
    });

    it('should convert boolean values to strings', () => {
      service.set('flag', true);
      expect(service.resolve('enabled={{flag}}')).toBe('enabled=true');
    });

    it('should throw for an undefined variable', () => {
      expect(() => service.resolve('{{missing}}')).toThrow(
        "Variable 'missing' is not defined",
      );
    });

    it('should list available variables in the error message', () => {
      service.set('a', '1');
      service.set('b', '2');
      expect(() => service.resolve('{{missing}}')).toThrow(
        'Available variables: a, b',
      );
    });

    it('should say "none" when no variables are available', () => {
      expect(() => service.resolve('{{missing}}')).toThrow(
        'Available variables: none',
      );
    });

    it('should not treat plain text with no braces as a variable', () => {
      expect(service.resolve('no braces here')).toBe('no braces here');
    });

    it('should return a string with no placeholders unchanged', () => {
      expect(service.resolve('no vars here')).toBe('no vars here');
    });

    it('should return an empty string unchanged', () => {
      expect(service.resolve('')).toBe('');
    });
  });

  describe('resolveObject', () => {
    it('should resolve variables in a flat object', () => {
      service.set('host', 'localhost');
      service.set('port', 3000);
      const result = service.resolveObject({
        url: 'http://{{host}}:{{port}}',
        label: 'static',
      });
      expect(result).toEqual({
        url: 'http://localhost:3000',
        label: 'static',
      });
    });

    it('should resolve variables in nested objects', () => {
      service.set('token', 'abc123');
      const result = service.resolveObject({
        headers: { Authorization: 'Bearer {{token}}' },
      });
      expect(result).toEqual({
        headers: { Authorization: 'Bearer abc123' },
      });
    });

    it('should resolve variables in arrays', () => {
      service.set('a', 'x');
      service.set('b', 'y');
      expect(service.resolveObject(['{{a}}', '{{b}}'])).toEqual(['x', 'y']);
    });

    it('should resolve arrays nested inside objects', () => {
      service.set('v', 'val');
      const result = service.resolveObject({ items: ['{{v}}', 'static'] });
      expect(result).toEqual({ items: ['val', 'static'] });
    });

    it('should pass through numbers unchanged', () => {
      expect(service.resolveObject(42)).toBe(42);
    });

    it('should pass through booleans unchanged', () => {
      expect(service.resolveObject(true)).toBe(true);
    });

    it('should pass through null unchanged', () => {
      expect(service.resolveObject(null)).toBeNull();
    });

    it('should pass through undefined unchanged', () => {
      expect(service.resolveObject(undefined)).toBeUndefined();
    });

    it('should handle a string input directly', () => {
      service.set('x', 'resolved');
      expect(service.resolveObject('{{x}}')).toBe('resolved');
    });
  });

  describe('clear', () => {
    it('should remove all variables', () => {
      service.set('a', '1');
      service.set('b', '2');
      service.clear();
      expect(service.get('a')).toBeUndefined();
      expect(service.get('b')).toBeUndefined();
    });

    it('should cause resolve to throw for previously set variables', () => {
      service.set('x', 'val');
      service.clear();
      expect(() => service.resolve('{{x}}')).toThrow(
        "Variable 'x' is not defined",
      );
    });
  });
});
