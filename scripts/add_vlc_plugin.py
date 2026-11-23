#!/usr/bin/env python3
"""Add a tiny native plugin that hands the current stream to VLC.

Capacitor's own bridge fires a bare ACTION_VIEW with no MIME type and no
package, which Android resolves to a browser rather than a video player. VLC
documents ACTION_VIEW + package org.videolan.vlc + setDataAndTypeAndNormalize,
so this writes a plugin that builds exactly that intent, registers it in
MainActivity, and declares package visibility for Android 11+.

Run after `npx cap add android`, from the repository root:
    python3 scripts/add_vlc_plugin.py android
"""
import pathlib
import re
import sys

APP_ID = "com.nxtv.app"
PKG_DIR = APP_ID.replace(".", "/")

PLUGIN = '''package %s;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Vlc")
public class VlcPlugin extends Plugin {

    private static final String VLC_PACKAGE = "org.videolan.vlc";

    private boolean vlcInstalled() {
        try {
            getContext().getPackageManager().getPackageInfo(VLC_PACKAGE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    @PluginMethod
    public void isInstalled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("installed", vlcInstalled());
        call.resolve(ret);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.length() == 0) {
            call.reject("No stream url was given.");
            return;
        }
        String title = call.getString("title", "");
        Double posRaw = call.getDouble("position", Double.valueOf(0));
        long position = posRaw == null ? 0L : posRaw.longValue();

        Uri uri = Uri.parse(url);

        Intent vlc = new Intent(Intent.ACTION_VIEW);
        vlc.setPackage(VLC_PACKAGE);
        vlc.setDataAndTypeAndNormalize(uri, "video/*");
        if (title != null && title.length() > 0) {
            vlc.putExtra("title", title);
        }
        if (position > 0) {
            vlc.putExtra("position", position);
        }
        vlc.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        try {
            getContext().startActivity(vlc);
            JSObject ret = new JSObject();
            ret.put("player", "vlc");
            call.resolve(ret);
            return;
        } catch (Exception ignored) {
            // VLC missing or refused the intent: offer any video player instead
        }

        Intent any = new Intent(Intent.ACTION_VIEW);
        any.setDataAndTypeAndNormalize(uri, "video/*");
        any.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(any);
            JSObject ret = new JSObject();
            ret.put("player", "other");
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("No video player is installed on this device.");
        }
    }
}
''' % APP_ID

MAIN_ACTIVITY = '''package %s;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VlcPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
''' % APP_ID

QUERIES = '''
    <queries>
        <package android:name="org.videolan.vlc" />
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:mimeType="video/*" />
        </intent>
    </queries>
'''


def main():
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "android")
    java_dir = root / "app/src/main/java" / PKG_DIR
    if not java_dir.exists():
        sys.exit("Java package folder not found: %s" % java_dir)

    (java_dir / "VlcPlugin.java").write_text(PLUGIN, encoding="utf-8")
    print("wrote %s" % (java_dir / "VlcPlugin.java"))

    (java_dir / "MainActivity.java").write_text(MAIN_ACTIVITY, encoding="utf-8")
    print("rewrote MainActivity.java to register the plugin")

    manifest = root / "app/src/main/AndroidManifest.xml"
    xml = manifest.read_text(encoding="utf-8")
    if "org.videolan.vlc" in xml:
        print("manifest already declares the queries block")
        return
    if not re.search(r"</manifest>", xml):
        sys.exit("Could not find </manifest> to patch.")
    xml = xml.replace("</manifest>", QUERIES + "</manifest>")
    manifest.write_text(xml, encoding="utf-8")
    print("added <queries> so Android 11+ can see VLC")


if __name__ == "__main__":
    main()
