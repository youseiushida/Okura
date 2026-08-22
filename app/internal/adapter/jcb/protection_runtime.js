import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { webcrypto } from "node:crypto";

export async function executeProtection({
  input,
  loginURL,
  initURL,
  asyncURL,
  initSource,
  asyncSource,
  cookieHeader,
}) {
  loginURL = new URL(loginURL);
  initURL = new URL(initURL);
  asyncURL = new URL(asyncURL);
  const origin = loginURL.origin;
  const cookieUpdates = [];
  const documentCookies = new Map();
  for (const part of String(cookieHeader).split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    documentCookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  const nonce = initSource.match(
    /currentScript&&document\.currentScript\.nonce\|\|"([^"]+)"/,
  )?.[1] || "";

  class SimpleEvent {
    constructor(type = "", init = {}) {
      this.type = type;
      this.bubbles = Boolean(init.bubbles);
      this.cancelable = Boolean(init.cancelable);
      this.defaultPrevented = false;
      this._cancelBubble = false;
      this.target = null;
      this.currentTarget = null;
      this.timeStamp = Date.now();
      this.isTrusted = false;
    }
    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
    stopPropagation() {
      this.cancelBubble = true;
    }
    stopImmediatePropagation() {
      this._cancelBubble = true;
      this.__stopImmediate = true;
    }
    get cancelBubble() {
      return this._cancelBubble;
    }
    set cancelBubble(value) {
      this._cancelBubble = Boolean(value);
    }
    initEvent(type, bubbles, cancelable) {
      this.type = type;
      this.bubbles = Boolean(bubbles);
      this.cancelable = Boolean(cancelable);
    }
  }

  class CustomEvent extends SimpleEvent {
    constructor(type = "", init = {}) {
      super(type, init);
      this._detail = init.detail;
    }
    get detail() {
      return this._detail;
    }
    initCustomEvent(type, bubbles, cancelable, detail) {
      this.initEvent(type, bubbles, cancelable);
      this._detail = detail;
    }
  }

  class UIEvent extends SimpleEvent {}
  class SubmitEvent extends SimpleEvent {}
  class KeyboardEvent extends UIEvent {}
  class MouseEvent extends UIEvent {}
  class FocusEvent extends UIEvent {}

  class EventTarget {
    constructor() {
      Object.defineProperty(this, "__listeners", { value: new Map() });
    }
    addEventListener(type, listener, options) {
      if (
        typeof listener !== "function" &&
        typeof listener?.handleEvent !== "function"
      ) {
        return;
      }
      const listeners = this.__listeners.get(type) || [];
      listeners.push({ listener, once: Boolean(options?.once) });
      this.__listeners.set(type, listeners);
    }
    removeEventListener(type, listener) {
      const listeners = this.__listeners.get(type) || [];
      this.__listeners.set(
        type,
        listeners.filter((entry) => entry.listener !== listener),
      );
    }
    dispatchEvent(event) {
      event.target ||= this;
      event.currentTarget = this;
      const listeners = [...(this.__listeners.get(event.type) || [])];
      for (const entry of listeners) {
        if (typeof entry.listener === "function") {
          entry.listener.call(this, event);
        } else entry.listener.handleEvent(event);
        if (entry.once) this.removeEventListener(event.type, entry.listener);
        if (event.__stopImmediate) break;
      }
      return !event.defaultPrevented;
    }
  }

  class Node extends EventTarget {
    constructor() {
      super();
      this.parentNode = null;
      this.childNodes = [];
      this.nodeType = 1;
    }
    appendChild(child) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    insertBefore(child, reference) {
      child.parentNode = this;
      const index = reference == null ? -1 : this.childNodes.indexOf(reference);
      if (index < 0) this.childNodes.push(child);
      else this.childNodes.splice(index, 0, child);
      return child;
    }
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    }
    get children() {
      return this.childNodes.filter((node) => node.nodeType === 1);
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    get lastChild() {
      return this.childNodes.at(-1) || null;
    }
  }
  Node.ELEMENT_NODE = 1;
  Node.DOCUMENT_NODE = 9;

  class Element extends Node {
    constructor(tagName = "div") {
      super();
      this.localName = String(tagName).toLowerCase();
      this.tagName = this.localName.toUpperCase();
      this.nodeName = this.tagName;
      this.attributes = Object.create(null);
      this.style = Object.create(null);
      this.dataset = Object.create(null);
      this.className = "";
      this.id = "";
      this.textContent = "";
      this.innerHTML = "";
      this.ownerDocument = null;
    }
    setAttribute(name, value) {
      const text = String(value);
      this.attributes[name] = text;
      if (
        name === "id" ||
        name === "class" ||
        name === "name" ||
        name === "type" ||
        name === "value"
      ) {
        this[name === "class" ? "className" : name] = text;
      }
    }
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    }
    hasAttribute(name) {
      return Object.hasOwn(this.attributes, name);
    }
    removeAttribute(name) {
      delete this.attributes[name];
    }
    querySelector() {
      return null;
    }
    querySelectorAll() {
      return [];
    }
    getBoundingClientRect() {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
      };
    }
    matches() {
      return false;
    }
    click() {
      this.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    }
  }

  class HTMLElement extends Element {
    constructor(tagName) {
      super(tagName);
      this.hidden = false;
    }
    focus() {}
    blur() {}
  }

  class HTMLAnchorElement extends HTMLElement {
    constructor() {
      super("a");
      this.__url = new URL(loginURL);
    }
    get href() {
      return this.__url.href;
    }
    set href(value) {
      this.__url = new URL(String(value), loginURL);
    }
    get protocol() {
      return this.__url.protocol;
    }
    get host() {
      return this.__url.host;
    }
    get hostname() {
      return this.__url.hostname;
    }
    get port() {
      return this.__url.port;
    }
    get pathname() {
      return this.__url.pathname;
    }
    get search() {
      return this.__url.search;
    }
    get hash() {
      return this.__url.hash;
    }
  }

  class HTMLInputElement extends HTMLElement {
    constructor() {
      super("input");
      this.type = "text";
      this.name = "";
      this.value = "";
      this.checked = false;
      this.disabled = false;
    }
  }

  let submitted = false;
  class HTMLFormElement extends HTMLElement {
    constructor() {
      super("form");
      this.name = "loginForm";
      this._method = "post";
      this._action = `${origin}/iss-pc/member/user_manage/Login`;
      this.enctype = "application/x-www-form-urlencoded";
      this.elements = [];
      this.setAttribute("name", this.name);
      this.setAttribute("method", "POST");
      this.setAttribute("action", "/iss-pc/member/user_manage/Login");
    }
    get method() {
      return this._method;
    }
    set method(value) {
      this._method = String(value);
    }
    get action() {
      return this._action;
    }
    set action(value) {
      this._action = String(value);
    }
    appendChild(child) {
      super.appendChild(child);
      if (child instanceof HTMLInputElement) this.elements.push(child);
      return child;
    }
    insertBefore(child, reference) {
      super.insertBefore(child, reference);
      if (child instanceof HTMLInputElement && !this.elements.includes(child)) {
        const referenceIndex = this.elements.indexOf(reference);
        if (referenceIndex < 0) this.elements.push(child);
        else this.elements.splice(referenceIndex, 0, child);
      }
      return child;
    }
    submit() {
      submitted = true;
    }
    requestSubmit() {
      return this.submit();
    }
  }

  class HTMLCanvasElement extends HTMLElement {
    constructor() {
      super("canvas");
      this.width = 300;
      this.height = 150;
    }
    getContext() {
      return null;
    }
    toDataURL() {
      return "data:,";
    }
  }

  class HTMLIFrameElement extends HTMLElement {
    constructor() {
      super("iframe");
      this.contentWindow = null;
      this.contentDocument = null;
    }
  }

  class HTMLImageElement extends HTMLElement {
    constructor() {
      super("img");
    }
  }
  class Image extends HTMLImageElement {}

  class XMLHttpRequest extends EventTarget {
    constructor() {
      super();
      this.readyState = XMLHttpRequest.UNSENT;
      this._timeout = 0;
      this.requestHeaders = Object.create(null);
    }
    get timeout() {
      return this._timeout;
    }
    set timeout(value) {
      this._timeout = Number(value);
    }
    open(method, url, async = true) {
      this.method = method;
      this.url = new URL(url, loginURL).href;
      this.async = async;
      this.readyState = XMLHttpRequest.OPENED;
    }
    setRequestHeader(name, value) {
      this.requestHeaders[name] = String(value);
    }
    send() {
      this.readyState = XMLHttpRequest.DONE;
    }
    abort() {
      this.readyState = XMLHttpRequest.UNSENT;
    }
  }
  XMLHttpRequest.UNSENT = 0;
  XMLHttpRequest.OPENED = 1;
  XMLHttpRequest.DONE = 4;

  const form = new HTMLFormElement();
  for (
    const [name, value, type = "hidden"] of [
      ["userId", input.userID, "text"],
      ["password", input.password, "password"],
      ["screenId", "0102001"],
      ["loginRouteId", "0102001"],
    ]
  ) {
    const input = new HTMLInputElement();
    input.name = name;
    input.id = name;
    input.type = type;
    input.value = value;
    form.appendChild(input);
  }

  class Document extends Node {
    constructor() {
      super();
      this.nodeType = 9;
      this.readyState = "complete";
      this.visibilityState = "visible";
      this.hidden = false;
      this.characterSet = "UTF-8";
      this.charset = "UTF-8";
      this.compatMode = "CSS1Compat";
      this.URL = loginURL.href;
      this.documentURI = loginURL.href;
      this.referrer = "";
      this.title = "MyJCB";
      this.documentElement = new HTMLElement("html");
      this.head = new HTMLElement("head");
      this.body = new HTMLElement("body");
      this.documentElement.ownerDocument = this;
      this.head.ownerDocument = this;
      this.body.ownerDocument = this;
      this.documentElement.appendChild(this.head);
      this.documentElement.appendChild(this.body);
      this.body.appendChild(form);
      this.forms = [form];
      this.forms.namedItem = (name) => (name === "loginForm" ? form : null);
      this.currentScript = { src: initURL.href, nonce };
      form.ownerDocument = this;
    }
    get cookie() {
      return [...documentCookies].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    set cookie(value) {
      const serialized = String(value);
      cookieUpdates.push(serialized);
      const pair = serialized.split(";", 1)[0] || "";
      const separator = pair.indexOf("=");
      if (separator > 0) {
        documentCookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      }
    }
    createElement(tagName) {
      let element;
      switch (String(tagName).toLowerCase()) {
        case "a":
          element = new HTMLAnchorElement();
          break;
        case "input":
          element = new HTMLInputElement();
          break;
        case "form":
          element = new HTMLFormElement();
          break;
        case "canvas":
          element = new HTMLCanvasElement();
          break;
        case "iframe":
          element = new HTMLIFrameElement();
          break;
        case "img":
          element = new HTMLImageElement();
          break;
        default:
          element = new HTMLElement(tagName);
      }
      element.ownerDocument = this;
      return element;
    }
    createElementNS(_namespace, tagName) {
      return this.createElement(tagName);
    }
    createEvent(type) {
      return type === "CustomEvent" ? new CustomEvent() : new SimpleEvent();
    }
    getElementById(id) {
      return form.elements.find((element) => element.id === id) || null;
    }
    getElementsByTagName(name) {
      if (String(name).toLowerCase() === "form") return [form];
      return [];
    }
    querySelector(selector) {
      if (selector === "form" || selector.includes("loginForm")) return form;
      if (selector.startsWith("#")) {
        return this.getElementById(selector.slice(1));
      }
      return null;
    }
    querySelectorAll(selector) {
      if (selector === "form") return [form];
      if (selector === "input") return form.elements;
      return [];
    }
  }

  const document = new Document();
  const windowTarget = new EventTarget();
  const location = new URL(loginURL);
  const navigator = {
    userAgent: input.userAgent,
    platform: "Win32",
    language: "ja-JP",
    languages: ["ja-JP", "ja", "en-US", "en"],
    cookieEnabled: true,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    webdriver: false,
    vendor: "Google Inc.",
    product: "Gecko",
    plugins: [],
    mimeTypes: [],
  };
  const screen = {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1040,
    colorDepth: 24,
    pixelDepth: 24,
    orientation: { type: "landscape-primary", angle: 0 },
  };
  const CSS = {
    escape(value) {
      return String(value).replace(
        /[^a-zA-Z0-9_-]/g,
        (character) => `\\${character}`,
      );
    },
  };
  const pendingTimeouts = new Set();
  const pendingIntervals = new Set();
  const trackedSetTimeout = (callback, delay, ...args) => {
    const handle = setTimeout(() => {
      pendingTimeouts.delete(handle);
      callback(...args);
    }, delay);
    pendingTimeouts.add(handle);
    return handle;
  };
  const trackedClearTimeout = (handle) => {
    pendingTimeouts.delete(handle);
    clearTimeout(handle);
  };
  const trackedSetInterval = (callback, delay, ...args) => {
    const handle = setInterval(callback, delay, ...args);
    pendingIntervals.add(handle);
    return handle;
  };
  const trackedClearInterval = (handle) => {
    pendingIntervals.delete(handle);
    clearInterval(handle);
  };

  const globals = {
    document,
    location,
    navigator,
    screen,
    CSS,
    performance,
    crypto: webcrypto,
    EventTarget,
    Event: SimpleEvent,
    CustomEvent,
    UIEvent,
    SubmitEvent,
    KeyboardEvent,
    MouseEvent,
    FocusEvent,
    Node,
    Document,
    Element,
    HTMLElement,
    HTMLAnchorElement,
    HTMLInputElement,
    HTMLFormElement,
    HTMLCanvasElement,
    HTMLIFrameElement,
    HTMLImageElement,
    Image,
    DOMException,
    URL,
    URLSearchParams,
    XMLHttpRequest,
    TextEncoder,
    TextDecoder,
    Blob,
    FormData,
    Headers,
    Request,
    Response,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
    innerWidth: 1920,
    innerHeight: 969,
    outerWidth: 1920,
    outerHeight: 1080,
    devicePixelRatio: 1,
    pageXOffset: 0,
    pageYOffset: 0,
    history: { length: 1, state: null },
    localStorage: {
      length: 0,
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
      clear() {},
    },
    sessionStorage: {
      length: 0,
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
      clear() {},
    },
    getComputedStyle() {
      return {
        getPropertyValue() {
          return "";
        },
      };
    },
    matchMedia() {
      return {
        matches: false,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
      };
    },
  };
  Object.assign(windowTarget, globals);
  windowTarget.window = windowTarget;
  windowTarget.self = windowTarget;
  windowTarget.top = windowTarget;
  windowTarget.parent = windowTarget;
  windowTarget.frames = windowTarget;
  windowTarget.length = 0;
  windowTarget.name = "";
  windowTarget.closed = false;
  windowTarget.addEventListener = windowTarget.addEventListener.bind(windowTarget);
  windowTarget.removeEventListener = windowTarget.removeEventListener.bind(windowTarget);
  windowTarget.dispatchEvent = windowTarget.dispatchEvent.bind(windowTarget);

  Object.assign(globals, {
    window: windowTarget,
    self: windowTarget,
    top: windowTarget,
    parent: windowTarget,
    globalThis: windowTarget,
    addEventListener: windowTarget.addEventListener,
    removeEventListener: windowTarget.removeEventListener,
    dispatchEvent: windowTarget.dispatchEvent,
  });
  Object.assign(windowTarget, globals);
  document.defaultView = windowTarget;
  document.loginForm = form;

  const context = vm.createContext(windowTarget);
  try {
    const appendToHead = document.head.appendChild.bind(document.head);
    document.head.appendChild = (child) => {
      appendToHead(child);
      if (child.localName === "script") {
        const sourceURL = new URL(String(child.src), initURL);
        if (sourceURL.href === asyncURL.href) {
          document.currentScript = child;
          vm.runInContext(asyncSource, context, {
            filename: "login-prot.async.js",
            timeout: 20000,
          });
          document.currentScript = null;
        }
      }
      return child;
    };

    vm.runInContext(initSource, context, {
      filename: "login-prot.init.js",
      timeout: 20000,
    });
    document.dispatchEvent(new SimpleEvent("DOMContentLoaded"));
    windowTarget.dispatchEvent(new SimpleEvent("load"));

    await new Promise((resolve) => setTimeout(resolve, 25));
    for (const control of form.elements.slice(0, 2)) {
      control.dispatchEvent(new SimpleEvent("input", { bubbles: true }));
      control.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    }
    form.submit();
    if (!submitted) {
      throw new Error("MyJCB protected form submission was not captured");
    }

    const body = new URLSearchParams();
    for (const control of form.elements) {
      if (control.name && !control.disabled) {
        body.append(control.name, String(control.value));
      }
    }
    return { action: form.action, body: body.toString(), cookieUpdates };
  } finally {
    for (const handle of pendingTimeouts) clearTimeout(handle);
    for (const handle of pendingIntervals) clearInterval(handle);
  }
}
