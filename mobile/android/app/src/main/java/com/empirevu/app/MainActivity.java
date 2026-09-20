package com.empirevu.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be registered before the bridge loads the web app.
        registerPlugin(PushAvailability.class);
        super.onCreate(savedInstanceState);
    }
}
