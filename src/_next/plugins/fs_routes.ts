import { AnyComponent } from "preact";
import { App } from "../app.ts";
import { WalkEntry } from "jsr:@std/fs/walk";
import * as path from "jsr:@std/path";
import { RouteConfig } from "$fresh/src/server/mod.ts";
import { RouteHandler } from "../defines.ts";
import { FreshContext } from "../context.ts";
import { compose, Middleware } from "../middlewares/compose.ts";
import { renderMiddleware } from "../middlewares/render/render_middleware.ts";
import { Method, pathToPattern } from "../router.ts";
import { HandlerFn, isHandlerMethod } from "$fresh/src/_next/defines.ts";
import { FsAdapter, fsAdapter } from "$fresh/src/_next/fs.ts";

const TEST_FILE_PATTERN = /[._]test\.(?:[tj]sx?|[mc][tj]s)$/;

interface InternalRoute<T> {
  path: string;
  base: string;
  filePath: string;
  config: RouteConfig | null;
  handlers: RouteHandler<unknown, T> | null;
  component: AnyComponent<FreshContext<T>> | null;
}

export interface FreshFsItem<T = unknown> {
  config?: RouteConfig;
  handler?: RouteHandler<unknown, T>;
  handlers?: RouteHandler<unknown, T>;
  default?: AnyComponent<FreshContext<T>>;
}

// deno-lint-ignore no-explicit-any
function isFreshFile(mod: any): mod is FreshFsItem {
  return mod !== null && typeof mod === "object" &&
      typeof mod.default === "function" ||
    typeof mod.config === "object" || typeof mod.handlers === "object" ||
    typeof mod.handlers === "function" || typeof mod.handler === "object" ||
    typeof mod.handler === "function";
}

export interface FsRoutesOptions {
  dir: string;
  ignoreFilePattern?: RegExp[];
  load: (path: string) => Promise<unknown>;
  /**
   * Only used for testing.
   */
  _fs?: FsAdapter;
}

export async function fsRoutes<T>(app: App<T>, options: FsRoutesOptions) {
  const ignore = options.ignoreFilePattern ?? [TEST_FILE_PATTERN];
  const fs = options._fs ?? fsAdapter;

  const islandDir = path.join(options.dir, "islands");
  const routesDir = path.join(options.dir, "routes");

  const relIslandsPaths: string[] = [];
  const relRoutePaths: string[] = [];

  // Walk routes folder
  await Promise.all([
    walkDir(
      islandDir,
      (entry) => {
        // FIXME
        // console.log("islands", entry);
      },
      ignore,
      fs,
    ),
    walkDir(
      routesDir,
      (entry) => {
        // FIXME: Route groups
        const relative = path.relative(routesDir, entry.path);
        relRoutePaths.push(relative);
      },
      ignore,
      fs,
    ),
  ]);

  relIslandsPaths.sort();

  const routeModules: InternalRoute<T>[] = await Promise.all(
    relRoutePaths.map(async (routePath) => {
      const mod = await options.load(routePath);
      if (!isFreshFile(mod)) {
        throw new Error(
          `Expected a route, middleware, layout or error template, but couldn't find relevant exports in: ${routePath}`,
        );
      }

      const handlers = mod.handlers ?? mod.handler ?? null;
      if (typeof handlers === "function" && handlers.length > 1) {
        throw new Error(
          `Handlers must only have one argument but found more than one. Check the function signature in: ${
            path.join(routesDir, routePath)
          }`,
        );
      }

      const normalizedPath = `/${
        routePath.slice(0, routePath.lastIndexOf("."))
      }`;
      const base = normalizedPath.slice(0, normalizedPath.lastIndexOf("/"));
      return {
        path: normalizedPath,
        filePath: routePath,
        base,
        handlers: mod.handlers ?? mod.handler ?? null,
        config: mod.config ?? null,
        component: mod.default ?? null,
      } as InternalRoute<T>;
    }),
  );

  routeModules.sort((a, b) => sortRoutePaths(a.path, b.path));

  const stack: InternalRoute<T>[] = [];
  let hasApp = false;

  for (let i = 0; i < routeModules.length; i++) {
    const routeMod = routeModules[i];
    const normalized = routeMod.path;

    let j = stack.length - 1;
    while (
      j >= 0 && stack[j].base !== "" &&
      !routeMod.path.startsWith(stack[j].base + "/")
    ) {
      j--;
      stack.pop();
    }

    if (normalized.endsWith("/_app")) {
      hasApp = true;
      stack.push(routeMod);
      continue;
    } else if (normalized.endsWith("/_middleware")) {
      stack.push(routeMod);
      continue;
    } else if (normalized.endsWith("/_layout")) {
      stack.push(routeMod);
      continue;
    } else if (normalized.endsWith("/_error")) {
      stack.push(routeMod);
      continue;
    }

    // Remove any elements not matching our parent path anymore
    const middlewares: Middleware<T>[] = [];
    let components: AnyComponent<FreshContext<T>>[] = [];

    let skipApp = !!routeMod.config?.skipAppWrapper;
    const skipLayouts = !!routeMod.config?.skipInheritedLayouts;

    for (let k = 0; k < stack.length; k++) {
      const mod = stack[k];
      if (mod.handlers !== null && !isHandlerMethod(mod.handlers)) {
        if (mod.path.endsWith("/_middleware")) {
          // FIXME: Decide what to do with Middleware vs Handler type
          middlewares.push(mod.handlers as Middleware<T>);
        }
      }

      // _app template
      if (skipApp && mod.path === "/_app") {
        hasApp = false;
        continue;
      } else if (!skipApp && mod.config?.skipAppWrapper) {
        skipApp = true;
        if (hasApp) {
          hasApp = false;
          // _app component is always first
          components.shift();
        }
      }

      // _layouts
      if (skipLayouts && mod.path.endsWith("/_layout")) {
        continue;
      } else if (!skipLayouts && mod.config?.skipInheritedLayouts) {
        const first = components.length > 0 ? components[0] : null;
        components = [];

        if (!skipApp && hasApp && first !== null) {
          components.push(first);
        }
      }

      if (mod.component !== null) {
        components.push(mod.component);
      }

      if (mod.path.endsWith("/_error")) {
        const handlers = mod.handlers;
        const handler = handlers === null ||
            (isHandlerMethod(handlers) && Object.keys(handlers).length === 0)
          ? undefined
          : typeof handlers === "function"
          ? handlers
          : undefined; // FIXME: Method handler
        const errorComponents = components.slice();
        if (mod.component !== null) {
          errorComponents.push(mod.component);
        }
        middlewares.push(errorMiddleware(errorComponents, handler));
      }
    }

    if (routeMod.component !== null) {
      components.push(routeMod.component);
    }

    const handlers = routeMod.handlers;
    const routePath = routeMod.config?.routeOverride ??
      pathToPattern(normalized.slice(1));

    if (
      handlers === null ||
      (isHandlerMethod(handlers) && Object.keys(handlers).length === 0)
    ) {
      const mid = addRenderHandler(components, middlewares, undefined);
      app.get(routePath, mid);
    } else if (isHandlerMethod(handlers)) {
      for (const method of Object.keys(handlers) as Method[]) {
        const fn = handlers[method];

        if (fn !== undefined) {
          const mid = addRenderHandler(components, middlewares, fn);
          const lower = method.toLowerCase() as Lowercase<Method>;
          app[lower](routePath, mid);
        }
      }
    } else if (typeof handlers === "function") {
      const mid = addRenderHandler(components, middlewares, handlers);
      app.all(routePath, renderMiddleware(components, mid));
    }
  }
}

function errorMiddleware<T>(
  components: AnyComponent<FreshContext<T>>[],
  handler: HandlerFn<unknown, T> | undefined,
): Middleware<T> {
  const mid = renderMiddleware<T>(components, handler);
  return async function errorMiddleware(ctx) {
    try {
      return await ctx.next();
    } catch (err) {
      ctx.error = err;
      return mid(ctx);
    }
  };
}

function addRenderHandler<T>(
  components: AnyComponent<FreshContext<T>>[],
  middlewares: Middleware<T>[],
  handler: HandlerFn<unknown, T> | undefined,
): Middleware<T> {
  let mid = renderMiddleware<T>(components, handler);
  if (middlewares.length > 0) {
    const chain = middlewares.slice();
    chain.push(mid);
    mid = compose(chain);
  }

  return mid;
}

async function walkDir(
  dir: string,
  callback: (entry: WalkEntry) => void,
  ignore: RegExp[],
  fs: FsAdapter,
) {
  if (!fs.isDirectory(dir)) return;

  const entries = fs.walk(dir, {
    includeDirs: false,
    includeFiles: true,
    exts: ["tsx", "jsx", "ts", "js"],
    skip: ignore,
  });

  for await (const entry of entries) {
    callback(entry);
  }
}

const APP_REG = /_app(?!\.[tj]sx?)?$/;

/**
 * Sort route paths where special Fresh files like `_app`,
 * `_layout` and `_middleware` are sorted in front.
 */
export function sortRoutePaths(a: string, b: string) {
  // The `_app` route should always be the first
  if (APP_REG.test(a)) return -1;
  else if (APP_REG.test(b)) return 1;

  let segmentIdx = 0;
  const aLen = a.length;
  const bLen = b.length;
  const maxLen = aLen > bLen ? aLen : bLen;
  for (let i = 0; i < maxLen; i++) {
    const charA = a.charAt(i);
    const charB = b.charAt(i);

    if (charA === "/" || charB === "/") {
      segmentIdx = i;

      // If the other path doesn't close the segment
      // then we don't need to continue
      if (charA !== "/") return 1;
      if (charB !== "/") return -1;

      continue;
    }

    if (i === segmentIdx + 1) {
      const scoreA = getRoutePathScore(charA, a, i);
      const scoreB = getRoutePathScore(charB, b, i);
      if (scoreA === scoreB) {
        if (charA !== charB) {
          // TODO: Do we need localeSort here or is this good enough?
          return charA < charB ? 0 : 1;
        }
        continue;
      }

      return scoreA > scoreB ? -1 : 1;
    }

    if (charA !== charB) {
      // TODO: Do we need localeSort here or is this good enough?
      return charA < charB ? 0 : 1;
    }
  }

  return 0;
}

/**
 * Assign a score based on the first two characters of a path segment.
 * The goal is to sort `_middleware` and `_layout` in front of everything
 * and `[` or `[...` last respectively.
 */
function getRoutePathScore(char: string, s: string, i: number): number {
  if (char === "_") {
    if (i + 1 < s.length && s[i + 1] === "m") return 5;
    return 4;
  } else if (char === "[") {
    if (i + 1 < s.length && s[i + 1] === ".") {
      return 0;
    }
    return 1;
  }

  if (
    i + 4 === s.length - 1 && char === "i" && s[i + 1] === "n" &&
    s[i + 2] === "d" && s[i + 3] === "e" && s[i + 4] === "x"
  ) {
    return 3;
  }

  return 2;
}
