import { useEffect, useState } from 'react';
import { View, StyleSheet, Alert } from 'react-native';
import { Button, Text, ActivityIndicator } from 'react-native-paper';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';
import {
  useBarcodeScanner,
  type Barcode,
} from '@mgcrea/vision-camera-barcode-scanner';
import { api } from '../api/client';
import { usePos } from '../state/pos.store';

/**
 * Barcode scanner screen.
 *
 * Uses Vision Camera 4.7 + mgcrea's barcode scanner plugin (locked on v0.12.3;
 * V5 is sponsor-only). Supports EAN-8/13, UPC-A/E, Code 128, Code 39, QR,
 * DataMatrix, ITF-14 — the Thai retail standards plus QR for receipts.
 *
 * iOS quirk handled server-side: Vision Camera reports UPC-A 12-digit barcodes
 * as 13-digit EAN with a leading zero. The API's /products/barcode endpoint
 * normalises both ways (checked in Session 1 verification).
 *
 * Device test pending: requires a real iPad build + camera permission grant.
 * The simulator has no camera, so this screen renders a "no camera" state
 * when run headlessly, which is correct behaviour.
 */
export default function ScannerScreen({ navigation }: { navigation: any }) {
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const add = usePos((s) => s.add);
  const [scanning, setScanning] = useState(true);
  const [lastCode, setLastCode] = useState<string | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

  const onBarcodeScanned = async (barcodes: Barcode[]) => {
    if (!scanning || barcodes.length === 0 || busy) return;
    const code = barcodes[0].value;
    if (!code || code === lastCode) return;
    setLastCode(code);
    setScanning(false);
    setBusy(true);
    try {
      type ProductDTO = {
        id: string;
        name: string;
        priceCents: number;
      };
      const p = await api<ProductDTO>(
        `/api/products/barcode/${encodeURIComponent(code)}`,
      );
      add({ id: p.id, name: p.name, priceCents: p.priceCents });
      Alert.alert('Added to cart', p.name, [
        { text: 'Back to POS', onPress: () => navigation.goBack() },
        { text: 'Scan next', onPress: () => { setScanning(true); setLastCode(null); } },
      ]);
    } catch (e: any) {
      setLookupErr(e.message ?? 'lookup failed');
      setScanning(true);
    } finally {
      setBusy(false);
    }
  };

  const { props: frameProcessor } = useBarcodeScanner({
    barcodeTypes: ['ean-13', 'ean-8', 'upc-a', 'upc-e', 'code-128', 'code-39', 'qr', 'data-matrix', 'itf-14'],
    onBarcodeScanned,
  });

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <Text variant="titleMedium">กล้องต้องได้รับอนุญาต / Camera permission required</Text>
        <Button mode="contained" onPress={requestPermission} style={{ marginTop: 16 }}>
          ขออนุญาต / Grant permission
        </Button>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <Text variant="titleMedium">ไม่พบกล้อง / No camera available</Text>
        <Text variant="bodySmall" style={{ marginTop: 8, opacity: 0.6 }}>
          (Simulator has no camera; build to a real iPad.)
        </Text>
        <Button mode="outlined" onPress={() => navigation.goBack()} style={{ marginTop: 16 }}>
          Back
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={scanning}
        {...(frameProcessor as any)}
      />
      <View style={styles.hud}>
        <Text variant="titleMedium" style={{ color: '#fff' }}>
          {scanning ? 'สแกนบาร์โค้ด / Scan barcode' : 'หยุด / Paused'}
        </Text>
        {busy && <ActivityIndicator color="#fff" style={{ marginTop: 8 }} />}
        {lastCode && <Text style={{ color: '#fff', opacity: 0.8 }}>Last: {lastCode}</Text>}
        {lookupErr && <Text style={{ color: '#f66' }}>{lookupErr}</Text>}
        <Button
          mode="contained"
          onPress={() => navigation.goBack()}
          style={{ marginTop: 16 }}
        >
          Back to POS
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  hud: {
    position: 'absolute',
    bottom: 32,
    left: 0,
    right: 0,
    alignItems: 'center',
    padding: 16,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
});
