import { registerRootComponent } from 'expo';
// Defines the background task for arriving and leaving; it has to exist before the OS wakes the app for it.
import './src/native/arrive-leave';
import App from './App';

registerRootComponent(App);
