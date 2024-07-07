import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { Socket } from 'node:net';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import graceful from 'graceful';
import { assign } from 'utility';
import { utils as eggUtils } from '@eggjs/core';
import { EggApplication, EggApplicationContext, EggApplicationOptions } from './egg.js';
import { AppWorkerLoader } from './loader/index.js';
import { BaseContextClass } from './core/base_context_class.js';

const EGG_LOADER = Symbol.for('egg#loader');

// client error => 400 Bad Request
// Refs: https://nodejs.org/dist/latest-v8.x/docs/api/http.html#http_event_clienterror
const DEFAULT_BAD_REQUEST_HTML = `<html>
  <head><title>400 Bad Request</title></head>
  <body bgcolor="white">
  <center><h1>400 Bad Request</h1></center>
  <hr><center>❤</center>
  </body>
  </html>`;
const DEFAULT_BAD_REQUEST_HTML_LENGTH = Buffer.byteLength(DEFAULT_BAD_REQUEST_HTML);
const DEFAULT_BAD_REQUEST_RESPONSE =
  `HTTP/1.1 400 Bad Request\r\nContent-Length: ${DEFAULT_BAD_REQUEST_HTML_LENGTH}` +
  `\r\n\r\n${DEFAULT_BAD_REQUEST_HTML}`;

// Refs: https://github.com/nodejs/node/blob/b38c81/lib/_http_outgoing.js#L706-L710
function escapeHeaderValue(value: string) {
  // Protect against response splitting. The regex test is there to
  // minimize the performance impact in the common case.
  return /[\r\n]/.test(value) ? value.replace(/[\r\n]+[ \t]*/g, '') : value;
}

/**
 * The Helper class which can be used as utility function.
 * We support developers to extend Helper through ${baseDir}/app/extend/helper.js ,
 * then you can use all method on `ctx.helper` that is a instance of Helper.
 */
class HelperClass extends BaseContextClass {}

/**
 * Singleton instance in App Worker, extend {@link EggApplication}
 * @augments EggApplication
 */
export class Application extends EggApplication {
  // will auto set after 'server' event emit
  server?: http.Server;
  #locals: Record<string, any> = {};
  /**
   * reference to {@link Helper}
   * @member {Helper} Application#Helper
   */
  Helper = HelperClass;

  /**
   * @class
   * @param {Object} options - see {@link EggApplication}
   */
  constructor(options?: Omit<EggApplicationOptions, 'type'>) {
    super({
      ...options,
      type: 'application',
    });
  }

  protected async load() {
    await super.load();
    this.#warnConfusedConfig();
    this.#bindEvents();
  }

  get [EGG_LOADER]() {
    return AppWorkerLoader;
  }

  #responseRaw(socket: Socket, raw?: any) {
    /* istanbul ignore next */
    if (!socket.writable) return;
    if (!raw) {
      return socket.end(DEFAULT_BAD_REQUEST_RESPONSE);
    }

    const body = (raw.body == null) ? DEFAULT_BAD_REQUEST_HTML : raw.body;
    const headers = raw.headers || {};
    const status = raw.status || 400;

    let responseHeaderLines = '';
    const firstLine = `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Unknown'}`;

    // Not that safe because no validation for header keys.
    // Refs: https://github.com/nodejs/node/blob/b38c81/lib/_http_outgoing.js#L451
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-length') {
        delete headers[key];
        continue;
      }
      responseHeaderLines += `${key}: ${escapeHeaderValue(headers[key])}\r\n`;
    }

    responseHeaderLines += `Content-Length: ${Buffer.byteLength(body)}\r\n`;

    socket.end(`${firstLine}\r\n${responseHeaderLines}\r\n${body.toString()}`);
  }

  onClientError(err: any, socket: Socket) {
    // ignore when there is no http body, it almost like an ECONNRESET
    if (err.rawPacket) {
      this.logger.warn('[egg:application] A client (%s:%d) error [%s] occurred: %s',
        socket.remoteAddress,
        socket.remotePort,
        err.code,
        err.message);
    }

    if (typeof this.config.onClientError === 'function') {
      const p = eggUtils.callFn(this.config.onClientError, [ err, socket, this ]);

      // the returned object should be something like:
      //
      //   {
      //     body: '...',
      //     headers: {
      //       ...
      //     },
      //     status: 400
      //   }
      //
      // default values:
      //
      // + body: ''
      // + headers: {}
      // + status: 400
      p.then(ret => {
        this.#responseRaw(socket, ret || {});
      }).catch(err => {
        this.logger.error(err);
        this.#responseRaw(socket);
      });
    } else {
      // because it's a raw socket object, we should return the raw HTTP response
      // packet.
      this.#responseRaw(socket);
    }
  }

  onServer(server: http.Server) {
    // expose app.server
    this.server = server;
    // set ignore code
    const serverGracefulIgnoreCode = this.config.serverGracefulIgnoreCode || [];

    /* istanbul ignore next */
    graceful({
      server: [ server ],
      error: (err: Error, throwErrorCount: number) => {
        const originMessage = err.message;
        if (originMessage) {
          // shouldjs will override error property but only getter
          // https://github.com/shouldjs/should.js/blob/889e22ebf19a06bc2747d24cf34b25cc00b37464/lib/assertion-error.js#L26
          Object.defineProperty(err, 'message', {
            get() {
              return `${originMessage} (uncaughtException throw ${throwErrorCount} times on pid: ${process.pid})`;
            },
            configurable: true,
            enumerable: false,
          });
        }
        this.coreLogger.error(err);
      },
      ignoreCode: serverGracefulIgnoreCode,
    });

    server.on('clientError', (err, socket) => this.onClientError(err, socket as Socket));

    // server timeout
    if (typeof this.config.serverTimeout === 'number') {
      server.setTimeout(this.config.serverTimeout);
    }
  }

  /**
   * global locals for view
   * @member {Object} Application#locals
   * @see Context#locals
   */
  get locals() {
    return this.#locals;
  }

  set locals(val: Record<string, any>) {
    assign(this.#locals, val);
  }

  /**
   * save routers to `run/router.json`
   * @private
   */
  dumpConfig() {
    super.dumpConfig();

    // dump routers to router.json
    const rundir = this.config.rundir;
    const FULLPATH = this.loader.FileLoader.FULLPATH;
    try {
      const dumpRouterFile = path.join(rundir, 'router.json');
      const routers = [];
      for (const layer of this.router.stack) {
        routers.push({
          name: layer.name,
          methods: layer.methods,
          paramNames: layer.paramNames,
          path: layer.path,
          regexp: layer.regexp.toString(),
          stack: layer.stack.map((stack: any) => stack[FULLPATH] || stack._name || stack.name || 'anonymous'),
        });
      }
      fs.writeFileSync(dumpRouterFile, JSON.stringify(routers, null, 2));
    } catch (err: any) {
      this.coreLogger.warn(`dumpConfig router.json error: ${err.message}`);
    }
  }

  /**
   * Run async function in the background
   * @see Context#runInBackground
   * @param {Function} scope - the first args is an anonymous ctx
   */
  runInBackground(scope: (ctx: EggApplicationContext) => void) {
    const ctx = this.createAnonymousContext();
    if (!scope.name) {
      Reflect.set(scope, '_name', eggUtils.getCalleeFromStack(true));
    }
    this.ctxStorage.run(ctx, () => {
      ctx.runInBackground(scope);
    });
  }

  /**
   * Run async function in the anonymous context scope
   * @see Context#runInAnonymousContextScope
   * @param {Function} scope - the first args is an anonymous ctx, scope should be async function
   * @param {Request} [req] - if you want to mock request like querystring, you can pass an object to this function.
   */
  async runInAnonymousContextScope(scope: (ctx: EggApplicationContext) => Promise<void>, req?: unknown) {
    const ctx = this.createAnonymousContext(req);
    if (!scope.name) {
      Reflect.set(scope, '_name', eggUtils.getCalleeFromStack(true));
    }
    return await this.ctxStorage.run(ctx, async () => {
      return await scope(ctx as EggApplicationContext);
    });
  }

  /**
   * secret key for Application
   * @member {String} Application#keys
   */
  get keys() {
    if (!this._keys) {
      if (!this.config.keys) {
        if (this.config.env === 'local' || this.config.env === 'unittest') {
          const configPath = path.join(this.config.baseDir, 'config/config.default.js');
          console.error('Cookie need secret key to sign and encrypt.');
          console.error('Please add `config.keys` in %s', configPath);
        }
        throw new Error('Please set config.keys first');
      }
      this._keys = this.config.keys.split(',').map(s => s.trim());
    }
    return this._keys;
  }

  /**
   * bind app's events
   *
   * @private
   */
  #bindEvents() {
    // Browser Cookie Limits: http://browsercookielimits.squawky.net/
    this.on('cookieLimitExceed', ({ name, value, ctx }) => {
      const err = new Error(`cookie ${name}'s length(${value.length}) exceed the limit(4093)`);
      err.name = 'CookieLimitExceedError';
      ctx.coreLogger.error(err);
    });
    // expose server to support websocket
    this.once('server', (server: http.Server) => this.onServer(server));
  }

  /**
   * warn when confused configurations are present
   *
   * @private
   */
  #warnConfusedConfig() {
    const confusedConfigurations = this.config.confusedConfigurations;
    Object.keys(confusedConfigurations).forEach(key => {
      if (this.config[key] !== undefined) {
        this.logger.warn('[egg:application] Unexpected config key `%o` exists, Please use `%o` instead.',
          key, confusedConfigurations[key]);
      }
    });
  }
}
