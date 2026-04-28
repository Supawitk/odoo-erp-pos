import { useState } from 'react';
import { View } from 'react-native';
import { Button, Text, TextInput, useTheme } from 'react-native-paper';
import { v7 as uuidv7 } from 'uuid';
import { api } from '../api/client';
import { usePos, type Session } from '../state/pos.store';

export default function OpenSessionScreen({ navigation }: { navigation: any }) {
  const theme = useTheme();
  const setSession = usePos((s) => s.setSession);
  const [amount, setAmount] = useState('10000');
  const [userId] = useState(() => uuidv7());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    setErr(null);
    try {
      const s = await api<Session>('/api/pos/sessions/open', {
        method: 'POST',
        body: JSON.stringify({
          userId,
          openingBalanceCents: parseInt(amount, 10) || 0,
          deviceId: 'ipad',
        }),
      });
      setSession(s);
      navigation.replace('POS');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, padding: 24, justifyContent: 'center', backgroundColor: theme.colors.background }}>
      <Text variant="displaySmall" style={{ marginBottom: 8 }}>เปิดรอบขาย</Text>
      <Text variant="bodyMedium" style={{ marginBottom: 24, color: theme.colors.onSurfaceVariant }}>
        Open POS register
      </Text>
      <TextInput
        label="Opening float (satang)"
        value={amount}
        onChangeText={setAmount}
        keyboardType="numeric"
        mode="outlined"
        style={{ marginBottom: 16 }}
      />
      {err && <Text style={{ color: theme.colors.error, marginBottom: 12 }}>{err}</Text>}
      <Button mode="contained" onPress={open} loading={busy} disabled={busy}>
        เปิดรอบ / Open register
      </Button>
    </View>
  );
}
