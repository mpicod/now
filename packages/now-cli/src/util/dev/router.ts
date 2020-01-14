import url from 'url';
import PCRE from 'pcre-to-regexp';

import isURL from './is-url';
import DevServer from './server';

import { HttpHeadersConfig, RouteConfig, RouteResult } from './types';
import { isHandler, Route } from '@now/routing-utils';

export function resolveRouteParameters(
  str: string,
  match: string[],
  keys: string[]
): string {
  return str.replace(/\$([1-9a-zA-Z]+)/g, (_, param) => {
    let matchIndex: number = keys.indexOf(param);
    if (matchIndex === -1) {
      // It's a number match, not a named capture
      matchIndex = parseInt(param, 10);
    } else {
      // For named captures, add one to the `keys` index to
      // match up with the RegExp group matches
      matchIndex++;
    }
    return match[matchIndex] || '';
  });
}

export function getRoutesTypes(routes: Route[] = []) {
  const missRoutes: Route[] = [];
  const otherRoutes: Route[] = [];
  let isHandleMissPhase = false;

  for (const route of routes) {
    if (isHandler(route)) {
      isHandleMissPhase = route.handle === 'miss';
      if (isHandleMissPhase) {
        continue; // remove the `handle: miss`
      }
    }

    if (isHandleMissPhase) {
      missRoutes.push(route);
    } else {
      otherRoutes.push(route);
    }
  }

  return { missRoutes, otherRoutes };
}

export async function devRouter(
  reqUrl: string = '/',
  reqMethod?: string,
  routes?: RouteConfig[],
  devServer?: DevServer,
  previousHeaders?: HttpHeadersConfig,
  missRoutes?: RouteConfig[],
  phase?: 'top' | 'miss'
): Promise<RouteResult> {
  let found: RouteResult | undefined;
  let { query, pathname: reqPathname = '/' } = url.parse(reqUrl, true);
  const combinedHeaders: HttpHeadersConfig = { ...previousHeaders };

  // Try route match
  if (routes) {
    let idx = -1;
    for (const routeConfig of routes) {
      idx++;
      if (isHandler(routeConfig)) {
        if (routeConfig.handle === 'filesystem' && devServer) {
          const found = await devServer.hasFilesystem(reqPathname);
          if (found) {
            break;
          } else if (missRoutes && missRoutes.length > 0) {
            // Trigger a 'miss'
            const missResult = await devRouter(
              reqUrl,
              reqMethod,
              missRoutes,
              devServer,
              previousHeaders,
              [],
              'miss'
            );
            if (missResult.found) {
              return missResult;
            }
          }
        }
        continue;
      }

      let { src, headers, methods } = routeConfig;

      if (Array.isArray(methods) && reqMethod && !methods.includes(reqMethod)) {
        continue;
      }

      const keys: string[] = [];
      const matcher = PCRE(`%${src}%i`, keys);
      const match =
        matcher.exec(reqPathname) || matcher.exec(reqPathname.substring(1));

      if (match) {
        let destPath: string = reqPathname;

        if (routeConfig.dest) {
          destPath = resolveRouteParameters(routeConfig.dest, match, keys);
        }

        if (headers) {
          // Create a clone of the `headers` object to not mutate the original one
          headers = { ...headers };
          for (const key of Object.keys(headers)) {
            headers[key] = resolveRouteParameters(headers[key], match, keys);
          }

          for (const [key, value] of Object.entries(headers)) {
            if (
              phase === 'miss' &&
              previousHeaders &&
              // eslint-disable-next-line no-prototype-builtins
              previousHeaders.hasOwnProperty(key)
            ) {
              // don't override headers in the miss phase
            } else {
              combinedHeaders[key] = value;
            }
          }
        }

        if (routeConfig.continue) {
          if (phase === 'miss' && routeConfig.status === 404) {
            // Don't continue on miss route so that 404 works
          } else {
            reqPathname = destPath;
            continue;
          }
        }

        if (routeConfig.check && devServer) {
          const { pathname = '/' } = url.parse(destPath);
          const hasDestFile = await devServer.hasFilesystem(pathname);
          // If the file is not found, `check: true` will
          // behave the same as `continue: true`
          if (!hasDestFile) {
            if (missRoutes && missRoutes.length > 0) {
              // Trigger a 'miss'
              const missResult = await devRouter(
                destPath,
                reqMethod,
                missRoutes,
                devServer,
                previousHeaders,
                [],
                'miss'
              );
              if (missResult.found) {
                return missResult;
              }
            } else {
              reqPathname = destPath;
              continue;
            }
          }
        }

        if (isURL(destPath)) {
          found = {
            found: true,
            dest: destPath,
            userDest: false,
            status: routeConfig.status,
            headers: combinedHeaders,
            uri_args: query,
            matched_route: routeConfig,
            matched_route_idx: idx,
          };
          break;
        } else {
          if (!destPath.startsWith('/')) {
            destPath = `/${destPath}`;
          }
          const { pathname, query } = url.parse(destPath, true);
          found = {
            found: true,
            dest: pathname || '/',
            userDest: Boolean(routeConfig.dest),
            status: routeConfig.status,
            headers: combinedHeaders,
            uri_args: query,
            matched_route: routeConfig,
            matched_route_idx: idx,
          };
          break;
        }
      }
    }
  }

  if (!found) {
    found = {
      found: false,
      dest: reqPathname,
      uri_args: query,
      headers: combinedHeaders,
    };
  }

  return found;
}
