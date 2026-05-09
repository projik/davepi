import React, { useEffect, useState, useMemo } from 'react';
import { BrowserRouter, Routes, Route, Outlet, Navigate } from 'react-router-dom';
import {
  Refine,
  Authenticated,
} from '@refinedev/core';
import {
  ThemedLayoutV2,
  ErrorComponent,
  AuthPage,
  notificationProvider,
} from '@refinedev/antd';
import routerBindings, {
  CatchAllNavigate,
  NavigateToResource,
  UnsavedChangesNotifier,
  DocumentTitleHandler,
} from '@refinedev/react-router-v6';
import { ConfigProvider, Spin, Typography } from 'antd';
import 'antd/dist/reset.css';
import '@refinedev/antd/dist/reset.css';

import { createDataProvider } from './dataProvider.js';
import { createAuthProvider } from './authProvider.js';
import { loadSwaggerSpec, buildResources } from './specLoader.js';
import {
  ResourceList,
  ResourceShow,
  ResourceCreate,
  ResourceEdit,
} from './views.jsx';

const dataProvider = createDataProvider();
const authProvider = createAuthProvider();

/**
 * Boot flow:
 *   1. Hit /api-docs/swagger.json (the route is public — Swagger UI
 *      uses the same spec).
 *   2. Derive the resource list + per-resource field metadata.
 *   3. Hand it to Refine; the generic CRUD views bind themselves to
 *      whichever resource the URL says we're on.
 *
 * Without authentication the spec request still works (the route is
 * public on the server). The admin's Login page kicks in for any
 * resource view via `<Authenticated />`.
 */
export default function App() {
  const [resources, setResources] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadSwaggerSpec()
      .then((spec) => {
        if (cancelled) return;
        setResources(buildResources(spec));
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div style={{ padding: '2rem' }}>
        <Typography.Title level={3}>Could not load API spec</Typography.Title>
        <Typography.Paragraph>
          The admin UI fetches <code>/api-docs/swagger.json</code> at boot to
          discover resources. The request failed:
        </Typography.Paragraph>
        <Typography.Paragraph>
          <code>{error.message}</code>
        </Typography.Paragraph>
      </div>
    );
  }

  if (!resources) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <Spin size="large" tip="Discovering resources…" />
      </div>
    );
  }

  return (
    <BrowserRouter basename="/admin">
      <ConfigProvider>
        <Refine
          dataProvider={dataProvider}
          authProvider={authProvider}
          routerProvider={routerBindings}
          notificationProvider={notificationProvider}
          resources={resources}
          options={{
            syncWithLocation: true,
            warnWhenUnsavedChanges: true,
            useNewQueryKeys: true,
            disableTelemetry: true,
          }}
        >
          <Routes>
            <Route
              element={
                <Authenticated key="protected" fallback={<CatchAllNavigate to="/login" />}>
                  <ThemedLayoutV2 Title={({ collapsed }) => (
                    <Typography.Title level={4} style={{ margin: 0 }}>
                      {collapsed ? 'dP' : 'dAvePi'}
                    </Typography.Title>
                  )}>
                    <Outlet />
                  </ThemedLayoutV2>
                </Authenticated>
              }
            >
              {resources.length > 0 && (
                <Route index element={<NavigateToResource resource={resources[0].name} />} />
              )}
              {resources.map((r) => (
                <Route key={r.name} path={r.name}>
                  <Route
                    index
                    element={<ResourceList resourceName={r.name} fields={r.meta.fields} />}
                  />
                  <Route
                    path="show/:id"
                    element={<ResourceShow resourceName={r.name} fields={r.meta.fields} />}
                  />
                  <Route
                    path="create"
                    element={<ResourceCreate resourceName={r.name} fields={r.meta.fields} />}
                  />
                  <Route
                    path="edit/:id"
                    element={<ResourceEdit resourceName={r.name} fields={r.meta.fields} />}
                  />
                </Route>
              ))}
              <Route path="*" element={<ErrorComponent />} />
            </Route>
            <Route
              element={
                <Authenticated key="public" fallback={<Outlet />}>
                  <NavigateToResource />
                </Authenticated>
              }
            >
              <Route path="/login" element={<AuthPage type="login" />} />
            </Route>
          </Routes>
          <UnsavedChangesNotifier />
          <DocumentTitleHandler />
        </Refine>
      </ConfigProvider>
    </BrowserRouter>
  );
}
