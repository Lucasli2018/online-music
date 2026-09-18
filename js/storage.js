/* storage.js — 本地歌曲的 IndexedDB 持久化
 * 仅保存用户从设备上传的文件（含元数据），刷新 / 重开浏览器后依然存在。
 * 远程链接歌曲与示例曲不入库，另行用 localStorage 管理。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'coral-music';
  var DB_VERSION = 1;
  var STORE = 'localTracks';
  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error('当前浏览器不支持 IndexedDB'));
        return;
      }
      var req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
    return dbPromise;
  }

  function tx(mode) {
    return openDB().then(function (db) {
      return db.transaction(STORE, mode).objectStore(STORE);
    });
  }

  var Storage = {
    put: function (record) {
      return tx('readwrite').then(function (store) {
        return new Promise(function (resolve, reject) {
          var r = store.put(record);
          r.onsuccess = function () { resolve(record); };
          r.onerror = function () { reject(r.error); };
        });
      });
    },
    getAll: function () {
      return tx('readonly').then(function (store) {
        return new Promise(function (resolve, reject) {
          var r = store.getAll();
          r.onsuccess = function () { resolve(r.result || []); };
          r.onerror = function () { reject(r.error); };
        });
      });
    },
    get: function (id) {
      return tx('readonly').then(function (store) {
        return new Promise(function (resolve, reject) {
          var r = store.get(id);
          r.onsuccess = function () { resolve(r.result); };
          r.onerror = function () { reject(r.error); };
        });
      });
    },
    del: function (id) {
      return tx('readwrite').then(function (store) {
        return new Promise(function (resolve, reject) {
          var r = store.delete(id);
          r.onsuccess = function () { resolve(); };
          r.onerror = function () { reject(r.error); };
        });
      });
    },
    clear: function () {
      return tx('readwrite').then(function (store) {
        return new Promise(function (resolve, reject) {
          var r = store.clear();
          r.onsuccess = function () { resolve(); };
          r.onerror = function () { reject(r.error); };
        });
      });
    }
  };

  global.CM = global.CM || {};
  global.CM.Storage = Storage;
})(window);
