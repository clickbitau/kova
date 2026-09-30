import { registerRootComponent } from 'expo';
// Defines the background task for arriving and leaving; it has to exist before the OS wakes the app for it.
import './src/native/arrive-leave';
import { Platform } from 'react-native';
import { registerWidgetTaskHandler } from 'react-native-android-widget';
import App from './App';
import { widgetTaskHandler } from './src/widget/task-handler';

registerRootComponent(App);
// The Android home-screen widget draws itself and handles taps in a headless task.
if (Platform.OS === 'android') registerWidgetTaskHandler(widgetTaskHandler);
