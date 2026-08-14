import mqtt, { MqttClient } from 'mqtt';

const MQTT_BROKER = 'wss://broker.emqx.io:8084/mqtt';
const TOPIC_SYNC = 'playgol/sync/184d974d-929a-4d47-812c-35e4e28a3f4a';
const TOPIC_NOTIF = 'playgol/notif/184d974d-929a-4d47-812c-35e4e28a3f4a';

export interface SyncPayload {
  teams: any[];
  tournaments: any[];
  matches: any[];
  notifications: any[];
  notification?: any;
  timestamp: number;
  senderId?: string;
}

export type StateListener = (payload: SyncPayload) => void;
export type NotifListener = (notification: any) => void;

class RealtimeSyncManager {
  private client: MqttClient | null = null;
  private stateListeners: Set<StateListener> = new Set();
  private notifListeners: Set<NotifListener> = new Set();
  public clientId: string = `client-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  private isConnected: boolean = false;
  private pendingPublish: SyncPayload | null = null;

  constructor() {
    this.init();
  }

  private init() {
    if (typeof window === 'undefined') return;

    try {
      this.client = mqtt.connect(MQTT_BROKER, {
        clientId: this.clientId,
        clean: true,
        reconnectPeriod: 2000,
        connectTimeout: 5000,
        keepalive: 30
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        this.client?.subscribe([TOPIC_SYNC, TOPIC_NOTIF], { qos: 1 });

        if (this.pendingPublish) {
          this.publishState(this.pendingPublish);
          this.pendingPublish = null;
        }
      });

      this.client.on('message', (topic, message) => {
        try {
          const raw = message.toString();
          const parsed = JSON.parse(raw);

          if (topic === TOPIC_SYNC) {
            // Avoid echoing our own publish if received back
            this.stateListeners.forEach((listener) => {
              try {
                listener(parsed);
              } catch (e) {}
            });
          } else if (topic === TOPIC_NOTIF) {
            this.notifListeners.forEach((listener) => {
              try {
                listener(parsed);
              } catch (e) {}
            });
          }
        } catch (err) {}
      });

      this.client.on('error', () => {
        this.isConnected = false;
      });

      this.client.on('offline', () => {
        this.isConnected = false;
      });
    } catch (e) {
      console.warn('MQTT init error:', e);
    }
  }

  public subscribeState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  public subscribeNotif(listener: NotifListener): () => void {
    this.notifListeners.add(listener);
    return () => {
      this.notifListeners.delete(listener);
    };
  }

  public publishState(payload: SyncPayload) {
    payload.senderId = this.clientId;
    const str = JSON.stringify(payload);

    if (this.client && this.isConnected) {
      this.client.publish(TOPIC_SYNC, str, { retain: true, qos: 1 });
    } else {
      this.pendingPublish = payload;
    }
  }

  public publishNotification(notification: any) {
    if (this.client && this.isConnected) {
      this.client.publish(TOPIC_NOTIF, JSON.stringify(notification), { qos: 1 });
    }
  }
}

export const realtimeSync = new RealtimeSyncManager();
