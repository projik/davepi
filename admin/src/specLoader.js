import { apiFetch } from './api.js';

/**
 * Boot-time discovery: fetch `/api-docs/swagger.json`, derive the
 * list of resources to register with Refine, and produce a per-
 * resource field map that the generic CRUD views consume.
 *
 * Field shape after this transform:
 *   { name, type: 'string'|'number'|'boolean'|'date'|'array'|'object',
 *     enum?: string[], required?: boolean, fileField?: boolean,
 *     reference?: string }
 *
 * Mongoose-to-swagger emits OpenAPI 2.0 `properties` with `type` and
 * (for enums) `enum`. File fields are detectable by their nested
 * `properties: { key, size, contentType, ... }` shape.
 */

const FRAMEWORK_FIELDS = new Set([
  '_id',
  '__v',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'userId',
  'accountId',
]);

function inferFieldType(propSchema) {
  if (!propSchema) return 'string';
  if (propSchema.enum) return 'enum';
  switch (propSchema.type) {
    case 'string':
      if (propSchema.format === 'date-time' || propSchema.format === 'date') {
        return 'date';
      }
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
    case 'object':
      // File fields land here — they have a nested properties map
      // with `key`, `size`, `contentType`, etc.
      if (propSchema.properties && propSchema.properties.key) {
        return 'file';
      }
      return 'object';
    default:
      return 'string';
  }
}

export async function loadSwaggerSpec() {
  return apiFetch('/api-docs/swagger.json');
}

export function buildResources(spec) {
  if (!spec || !spec.definitions) return [];
  return Object.entries(spec.definitions)
    .filter(([name, def]) => def && def.properties)
    .map(([name, def]) => {
      const required = new Set(def.required || []);
      const fields = Object.entries(def.properties)
        .filter(([fieldName]) => !FRAMEWORK_FIELDS.has(fieldName))
        .map(([fieldName, prop]) => ({
          name: fieldName,
          type: inferFieldType(prop),
          enum: prop.enum,
          required: required.has(fieldName),
        }));
      return {
        name,
        // Refine uses these to wire the navigation menu and route
        // table; we keep them simple and let the generic views
        // handle the heavy lifting.
        list: `/${name}`,
        show: `/${name}/show/:id`,
        edit: `/${name}/edit/:id`,
        create: `/${name}/create`,
        meta: { fields },
      };
    });
}
