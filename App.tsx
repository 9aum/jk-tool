
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'react-native';

import HomeScreen from './src/screens/HomeScreen';
import DeviceDetailScreen from './src/screens/DeviceDetailScreen';
import { JKBMSDevice } from './src/services/BleService';

import { useFonts, Krub_400Regular, Krub_500Medium, Krub_700Bold } from '@expo-google-fonts/krub';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { Text, View, ActivityIndicator } from 'react-native';

const Stack = createNativeStackNavigator<RootStackParamList>();

export type RootStackParamList = {
    Home: undefined;
    DeviceDetail: { device: JKBMSDevice };
};

// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync();

export default function App() {
    let [fontsLoaded] = useFonts({
        Krub_400Regular,
        Krub_500Medium,
        Krub_700Bold,
    });

    useEffect(() => {
        async function prepare() {
            if (fontsLoaded) {
                await SplashScreen.hideAsync();
            }
        }
        prepare();
    }, [fontsLoaded]);

    if (!fontsLoaded) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <ActivityIndicator size="large" />
            </View>
        );
    }

    return (
        <SafeAreaProvider>
            <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
            <NavigationContainer>
                <Stack.Navigator
                    initialRouteName="Home"
                    screenOptions={{
                        headerTitleStyle: { fontFamily: 'Krub_700Bold' },
                        contentStyle: { backgroundColor: '#F5F5F5' },
                    }}
                >
                    <Stack.Screen
                        name="Home"
                        component={HomeScreen}
                        options={{ title: 'JK-Tool' }}
                    />
                    <Stack.Screen
                        name="DeviceDetail"
                        component={DeviceDetailScreen}
                        options={({ route }) => ({ title: route.params.device.name })}
                    />
                </Stack.Navigator>
            </NavigationContainer>
        </SafeAreaProvider>
    );
}
