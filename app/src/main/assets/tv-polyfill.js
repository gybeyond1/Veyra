/* 电视端的 API 兜底（ES5 手写，不做语法转换 —— 这个文件本身必须能被老 WebView 解析）
 *
 * 电视盒子 / 投影仪的 Android System WebView 常年停在 Chrome 60 左右，缺的正是这几个：
 *   Element.replaceChildren (86)、String.replaceAll (85)、Object.fromEntries (73)、
 *   Array.flatMap (69)、Element.toggleAttribute (69)、Promise.finally (63)。
 * app.js 里 replaceChildren 用了 4 次、replaceAll 2 次，缺任一个都会在启动时直接抛 TypeError，
 * 页面停在空骨架 —— 表现和白屏几乎一样，很难查。所以这里先补齐，再让 app.es5.js 跑。
 *
 * 只补「缺了就会崩」的，不追求完全等价；签名和行为按 MDN 的定义来。
 */
(function () {
  'use strict';

  if (!Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (var i = 0; i < arguments.length; i++) {
        var node = arguments[i];
        if (node === null || node === undefined) continue;
        this.appendChild(typeof node === 'string' ? document.createTextNode(node) : node);
      }
    };
  }

  if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function (search, replacement) {
      if (Object.prototype.toString.call(search) === '[object RegExp]') {
        if (!search.global) throw new TypeError('replaceAll must be called with a global RegExp');
        return this.replace(search, replacement);
      }
      return this.split(String(search)).join(String(replacement));
    };
  }

  if (!Object.fromEntries) {
    Object.fromEntries = function (entries) {
      var out = {};
      if (!entries) return out;
      var list = entries[Symbol.iterator] ? entries : entries;
      var it = list[Symbol.iterator]();
      for (var step = it.next(); !step.done; step = it.next()) {
        var pair = step.value;
        out[pair[0]] = pair[1];
      }
      return out;
    };
  }

  if (!Array.prototype.flatMap) {
    Array.prototype.flatMap = function (callback, thisArg) {
      var out = [];
      for (var i = 0; i < this.length; i++) {
        var mapped = callback.call(thisArg, this[i], i, this);
        if (Array.isArray(mapped)) {
          for (var j = 0; j < mapped.length; j++) out.push(mapped[j]);
        } else {
          out.push(mapped);
        }
      }
      return out;
    };
  }

  if (!Array.prototype.flat) {
    Array.prototype.flat = function (depth) {
      var level = depth === undefined ? 1 : Number(depth);
      var flatten = function (input, remaining) {
        var out = [];
        for (var i = 0; i < input.length; i++) {
          if (Array.isArray(input[i]) && remaining > 0) {
            var nested = flatten(input[i], remaining - 1);
            for (var j = 0; j < nested.length; j++) out.push(nested[j]);
          } else {
            out.push(input[i]);
          }
        }
        return out;
      };
      return flatten(this, level);
    };
  }

  if (!Element.prototype.toggleAttribute) {
    Element.prototype.toggleAttribute = function (name, force) {
      var has = this.hasAttribute(name);
      var next = force === undefined ? !has : !!force;
      if (next) this.setAttribute(name, '');
      else this.removeAttribute(name);
      return next;
    };
  }

  if (window.Promise && !Promise.prototype['finally']) {
    Promise.prototype['finally'] = function (callback) {
      var run = function () { return callback(); };
      return this.then(
        function (value) { return Promise.resolve(run()).then(function () { return value; }); },
        function (error) { return Promise.resolve(run()).then(function () { throw error; }); }
      );
    };
  }
})();
