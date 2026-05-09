import { apiFetch } from './api.js';

/**
 * Refine data provider tailored to davepi's REST surface.
 *
 * Refine's expected shape:
 *   - getList:    ({ resource, pagination, sorters, filters, meta })
 *                 → { data: T[], total: number }
 *   - getOne:     ({ resource, id })  → { data: T }
 *   - create:     ({ resource, variables }) → { data: T }
 *   - update:     ({ resource, id, variables }) → { data: T }
 *   - deleteOne:  ({ resource, id }) → { data: T }
 *
 * davepi's REST list response is `{ results, totalResults, ... }`
 * paginated by `__page` and sorted by `__sort=field:dir`. Filters
 * map directly to query params (mongo-querystring on the server).
 */
export function createDataProvider({ apiVersion = 'v1' } = {}) {
  const url = (resource, id) =>
    id !== undefined && id !== null
      ? `/api/${apiVersion}/${resource}/${id}`
      : `/api/${apiVersion}/${resource}`;

  const buildListQuery = ({ pagination, sorters, filters, meta }) => {
    const qs = new URLSearchParams();
    if (pagination && pagination.current) {
      qs.set('__page', String(pagination.current));
    }
    if (sorters && sorters.length > 0) {
      const s = sorters[0];
      qs.set('__sort', `${s.field}:${s.order || 'asc'}`);
    }
    if (filters) {
      for (const f of filters) {
        if (!f.field) continue;
        // Refine sends { field, operator, value } — we only honor
        // simple equality for now (matches mongo-querystring's most
        // common use). Free-text search routes through `__q`.
        if (f.field === '__q') {
          if (f.value) qs.set('__q', String(f.value));
        } else if (f.value !== undefined && f.value !== '') {
          qs.set(f.field, String(f.value));
        }
      }
    }
    if (meta && meta.includeDeleted) qs.set('__includeDeleted', 'true');
    return qs.toString();
  };

  return {
    getApiUrl: () => apiVersion,

    async getList({ resource, pagination, sorters, filters, meta }) {
      const query = buildListQuery({ pagination, sorters, filters, meta });
      const path = query ? `${url(resource)}?${query}` : url(resource);
      const body = await apiFetch(path);
      return {
        data: body.results || [],
        total: typeof body.totalResults === 'number' ? body.totalResults : 0,
      };
    },

    async getOne({ resource, id }) {
      const data = await apiFetch(url(resource, id));
      return { data };
    },

    async create({ resource, variables }) {
      const data = await apiFetch(url(resource), {
        method: 'POST',
        body: variables,
      });
      return { data };
    },

    async update({ resource, id, variables }) {
      await apiFetch(url(resource, id), {
        method: 'PUT',
        body: variables,
      });
      // davepi PUT returns { matchedCount, modifiedCount }; refetch
      // so Refine's caches see the updated record shape.
      const data = await apiFetch(url(resource, id));
      return { data };
    },

    async deleteOne({ resource, id }) {
      await apiFetch(url(resource, id), { method: 'DELETE' });
      return { data: { id } };
    },

    async getMany({ resource, ids }) {
      // No native bulk-by-id; fan out and gather. Fine at admin
      // scale; if it ever isn't, the resource can expose an FTS or
      // composite filter.
      const results = await Promise.all(
        ids.map((id) => apiFetch(url(resource, id)))
      );
      return { data: results };
    },

    async custom({ url: customUrl, method = 'get', payload }) {
      const data = await apiFetch(customUrl, {
        method: method.toUpperCase(),
        body: payload,
      });
      return { data };
    },
  };
}
