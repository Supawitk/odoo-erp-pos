/**
 * OdooPOS iPad app — Phase 2 scaffold.
 *
 * Minimal navigation + real API wiring. Camera / Stripe Terminal / thermal
 * printer / WatermelonDB offline sync are Phase 2C tasks blocked on native
 * toolchain work (Vision Camera v5 sponsor decision, Stripe Terminal beta,
 * cocoapods dep upgrade).
 */
import 'react-native-gesture-handler';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { PaperProvider, MD3LightTheme, adaptNavigationTheme } from 'react-native-paper';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import OpenSessionScreen from './src/screens/OpenSessionScreen';
import PosScreen from './src/screens/PosScreen';
import ScannerScreen from './src/screens/ScannerScreen';

const Stack = createNativeStackNavigator();
const qc = new QueryClient();
const { LightTheme: NavTheme } = adaptNavigationTheme({ reactNavigationLight: undefined as any });

export default function App() {
  return (
    <SafeAreaProvider>
      <PaperProvider theme={MD3LightTheme}>
        <QueryClientProvider client={qc}>
          <NavigationContainer theme={NavTheme as any}>
            <Stack.Navigator
              initialRouteName="OpenSession"
              screenOptions={{ headerShown: false }}
            >
              <Stack.Screen name="OpenSession" component={OpenSessionScreen} />
              <Stack.Screen name="POS" component={PosScreen} />
              <Stack.Screen name="Scanner" component={ScannerScreen} />
            </Stack.Navigator>
          </NavigationContainer>
        </QueryClientProvider>
      </PaperProvider>
    </SafeAreaProvider>
  );
}
