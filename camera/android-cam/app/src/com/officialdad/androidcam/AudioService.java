package com.officialdad.androidcam;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public class AudioService extends Service {
    static final String TAG = "android-cam-audio";
    static final String SOCKET = "android-cam-audio";
    static final String TOKEN_FILE = "control-token-audio";
    static final int SAMPLE_RATE = 48000;
    static final int CHANNELS = 2;
    static final int BITS = 16;
    static final long IDLE_TIMEOUT_MS = 60_000L;

    private volatile boolean running;
    private volatile boolean connected;
    private volatile long lastClientAt;
    private volatile LocalServerSocket server;
    private volatile AudioRecord recorder;
    private Thread netThread;
    private Thread idleThread;

    @Override
    public void onCreate() {
        super.onCreate();
    }

    private void startWorkers() {
        if (running) return;
        startForeground(2, notification());
        running = true;
        lastClientAt = SystemClock.elapsedRealtime();
        netThread = new Thread(this::serve, "audio-net");
        netThread.start();
        idleThread = new Thread(this::watchIdle, "audio-idle");
        idleThread.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!authorized(intent)) {
            Log.w(TAG, "rejected start without control token");
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        startWorkers();
        return START_NOT_STICKY;
    }

    private boolean authorized(Intent intent) {
        if (intent == null) return false;
        String supplied = intent.getStringExtra("control_token");
        if (supplied == null || supplied.isEmpty()) return false;
        try (FileInputStream in = new FileInputStream(new File(getFilesDir(), TOKEN_FILE))) {
            byte[] buffer = new byte[128];
            int count = in.read(buffer);
            if (count <= 0) return false;
            String expected = new String(buffer, 0, count, StandardCharsets.UTF_8).trim();
            return expected.length() >= 16 && expected.equals(supplied);
        } catch (Exception error) {
            return false;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        closeQuietly(server);
        stopRecorder();
        super.onDestroy();
    }

    private void serve() {
        try {
            server = new LocalServerSocket(SOCKET);
            Log.i(TAG, "listening on localabstract:" + SOCKET);
            while (running) {
                LocalSocket socket = server.accept();
                Log.i(TAG, "client connected");
                connected = true;
                lastClientAt = SystemClock.elapsedRealtime();
                try {
                    stream(socket);
                } catch (Exception error) {
                    Log.w(TAG, "stream ended: " + error);
                } finally {
                    connected = false;
                    lastClientAt = SystemClock.elapsedRealtime();
                    closeQuietly(socket);
                }
            }
        } catch (IOException error) {
            if (running) Log.e(TAG, "socket error", error);
        } finally {
            closeQuietly(server);
            stopSelf();
        }
    }

    private void watchIdle() {
        while (running) {
            SystemClock.sleep(5_000);
            if (!running) return;
            if (!connected
                    && SystemClock.elapsedRealtime() - lastClientAt >= IDLE_TIMEOUT_MS) {
                Log.i(TAG, "no host for " + IDLE_TIMEOUT_MS + " ms, stopping");
                stopSelf();
                return;
            }
        }
    }

    private void stream(LocalSocket socket) throws IOException {
        AudioRecord record = createRecorder();
        if (record == null) {
            Log.e(TAG, "no usable AudioRecord");
            return;
        }

        recorder = record;
        try {
            record.startRecording();
            if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                throw new IOException("microphone did not start");
            }

            OutputStream out = socket.getOutputStream();
            out.write(new byte[] {
                'A', 'U', 'D', '0',
                (byte) SAMPLE_RATE, (byte) (SAMPLE_RATE >> 8),
                (byte) (SAMPLE_RATE >> 16), (byte) (SAMPLE_RATE >> 24),
                (byte) CHANNELS, 0, 0, 0,
                (byte) BITS, 0, 0, 0,
            });
            out.flush();

            int chunk = SAMPLE_RATE * CHANNELS * (BITS / 8) / 100;
            byte[] buffer = new byte[chunk];
            while (running) {
                int read = record.read(buffer, 0, buffer.length);
                if (read > 0) {
                    out.write(buffer, 0, read);
                    out.flush();
                } else if (read < 0) {
                    throw new IOException("AudioRecord.read=" + read);
                }
            }
        } finally {
            stopRecorder();
        }
    }

    private AudioRecord createRecorder() {
        int min = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_STEREO,
                AudioFormat.ENCODING_PCM_16BIT);
        if (min <= 0) min = 4096;

        int[] sources = {
            MediaRecorder.AudioSource.UNPROCESSED,
            MediaRecorder.AudioSource.CAMCORDER,
            MediaRecorder.AudioSource.MIC,
        };
        for (int source : sources) {
            try {
                AudioRecord record = new AudioRecord(
                        source,
                        SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_STEREO,
                        AudioFormat.ENCODING_PCM_16BIT,
                        Math.max(min * 2, 4096));
                if (record.getState() == AudioRecord.STATE_INITIALIZED) {
                    Log.i(TAG, "stereo source " + source + " buffer " + min);
                    return record;
                }
                record.release();
            } catch (Exception error) {
                Log.w(TAG, "source " + source + " failed: " + error);
            }
        }
        return null;
    }

    private void stopRecorder() {
        AudioRecord record = recorder;
        recorder = null;
        if (record == null) return;
        try {
            if (record.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                record.stop();
            }
        } catch (Exception ignored) {
        }
        try {
            record.release();
        } catch (Exception ignored) {
        }
    }

    private Notification notification() {
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager.class).createNotificationChannel(
                    new NotificationChannel(
                            "android-cam-audio",
                            "Микрофон Android",
                            NotificationManager.IMPORTANCE_LOW));
            builder = new Notification.Builder(this, "android-cam-audio");
        } else {
            builder = new Notification.Builder(this);
        }
        return builder.setContentTitle("Микрофон Android")
                .setContentText("Трансляция микрофона на компьютер")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .build();
    }

    private static void closeQuietly(Object closeable) {
        try {
            if (closeable instanceof LocalServerSocket) {
                ((LocalServerSocket) closeable).close();
            } else if (closeable instanceof LocalSocket) {
                ((LocalSocket) closeable).close();
            }
        } catch (IOException ignored) {
        }
    }
}
