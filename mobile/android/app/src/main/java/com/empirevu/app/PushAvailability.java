package com.empirevu.app;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.reflect.Method;
import java.util.List;

/**
 * Is Firebase actually initialized in this process?
 *
 * PushNotifications.register() calls FirebaseMessaging.getInstance(), which throws
 * IllegalStateException when the build has no google-services.json. That throw happens on
 * Capacitor's own plugin thread and takes the whole app down — a JS .catch() around
 * register() never sees it. The app asks here first and reports the problem instead.
 *
 * FirebaseApp is reached reflectively on purpose: firebase-messaging is an `implementation`
 * dependency of the push plugin, so it is on the runtime classpath but not this module's
 * compile classpath, and naming it here would pin a version that has to track the plugin's.
 */
@CapacitorPlugin(name = "PushAvailability")
public class PushAvailability extends Plugin {

    @PluginMethod
    public void check(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", firebaseInitialized(getContext()));
        call.resolve(result);
    }

    private static boolean firebaseInitialized(Context context) {
        try {
            Class<?> firebaseApp = Class.forName("com.google.firebase.FirebaseApp");
            Method getApps = firebaseApp.getMethod("getApps", Context.class);
            Object apps = getApps.invoke(null, context);
            return apps instanceof List && !((List<?>) apps).isEmpty();
        } catch (Throwable error) {
            // No Firebase on the classpath at all, or it failed to answer: either way, don't register.
            return false;
        }
    }
}
