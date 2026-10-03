/*
 * child-subreaper — minimal N-API bindings for PR_SET_CHILD_SUBREAPER.
 *
 * The supervision host becomes the nearest subreaper for its supervised
 * executions, so escaped orphans reparent to the host instead of init and
 * non-descendance becomes provable from parent chains (issue #157 option 1).
 * Built by scripts/build-child-subreaper.mjs; loaded by
 * src/host/execution/child-subreaper.ts.
 */
#include <node_api.h>
#include <sys/prctl.h>

static napi_value SetChildSubreaper(napi_env env, napi_callback_info info) {
  (void)info;
  int result = prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
  napi_value out;
  if (napi_create_int32(env, result, &out) != napi_ok) return NULL;
  return out;
}

static napi_value GetChildSubreaper(napi_env env, napi_callback_info info) {
  (void)info;
  unsigned long value = 0;
  int result = prctl(PR_GET_CHILD_SUBREAPER, &value, 0, 0, 0);
  napi_value out;
  int encoded = result == 0 ? (int)value : -1;
  if (napi_create_int32(env, encoded, &out) != napi_ok) return NULL;
  return out;
}

NAPI_MODULE_INIT() {
  napi_value set_fn;
  napi_value get_fn;
  if (napi_create_function(env, "setChildSubreaper", NAPI_AUTO_LENGTH, SetChildSubreaper, NULL,
                           &set_fn) != napi_ok)
    return NULL;
  if (napi_create_function(env, "getChildSubreaper", NAPI_AUTO_LENGTH, GetChildSubreaper, NULL,
                           &get_fn) != napi_ok)
    return NULL;
  if (napi_set_named_property(env, exports, "setChildSubreaper", set_fn) != napi_ok) return NULL;
  if (napi_set_named_property(env, exports, "getChildSubreaper", get_fn) != napi_ok) return NULL;
  return exports;
}
