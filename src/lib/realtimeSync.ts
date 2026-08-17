import mqtt, { MqttClient } from 'mqtt';

const PRIMARY_BROKER = 'wss://broker.hivemq.com:8884/mqtt';
const SECONDARY_BROKER = 'wss://broker.emqx.io:8084/mqtt';

const APP_ID = '184d974d-929a-4d47-812c-35e4e28a3f4a';
const TOPIC_ACTION = `playgol/v3/action/${APP_ID}`;
const TOPIC_SYNC = `playgol/v3/sync/${APP_ID}`;
const TOPIC_NOTIF = `playgol/v3/notif/${APP_ID}`;
const TOPIC_REQ = `playgol/v3/req/${APP_ID}`;

export interface SyncPayload {
  teams: any[];
  tournaments: any[];
  matches: any[];
  notifications: any[];
  notification?: any;
  timestamp: number;
  senderId?: string;
}

export type RealtimeAction = 
  | { type: 'MATCH_SCORE_UPDATE'; matchId: string; tournamentId: string; scoreA: number | null; scoreB: number | null; penaltiesA?: number | null; penaltiesB?: number | null; played: boolean; notifText?: string; timestamp: number }
  | { type: 'MATCHES_UPDATE'; tournamentId?: string; matches: any[]; notifText?: string; timestamp: number }
  | { type: 'MATCH_ADD'; match: any; timestamp: number }
  | { type: 'MATCH_DELETE'; matchId: string; timestamp: number }
  | { type: 'TOURNAMENT_CREATE'; tournament: any; matches?: any[]; notifText?: string; timestamp: number }
  | { type: 'TOURNAMENT_UPDATE'; tournament: any; notifText?: string; timestamp: number }
  | { type: 'TOURNAMENT_DELETE'; tournamentId: string; notifText?: string; timestamp: number }
  | { type: 'TEAM_CREATE'; team: any; notifText?: string; timestamp: number }
  | { type: 'TEAM_UPDATE'; team: any; notifText?: string; timestamp: number }
  | { type: 'TEAM_DELETE'; teamId: string; notifText?: string; timestamp: number }
  | { type: 'FULL_STATE'; state: SyncPayload; timestamp: number }
  | { type: 'REQUEST_SYNC'; senderId: string; timestamp: number };

export type ActionListener = (action: RealtimeAction, senderId?: string) => void;
export type StateListener = (payload: SyncPayload) => void;
export type NotifListener = (notification: any) => void;

class RealtimeSyncManager {
  private client: MqttClient | null = null;
  private actionListeners: Set<ActionListener> = new Set();
  private stateListeners: Set<StateListener> = new Set();
  private notifListeners: Set<NotifListener> = new Set();
  public clientId: string = `pg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  public isConnected: boolean = false;
  private currentBrokerIndex: number = 0;
  private brokers = [PRIMARY_BROKER, SECONDARY_BROKER];
  private retryTimeout: any = null;
  private pingInterval: any = null;

  constructor() {
    this.init();
    this.setupLifecycleHooks();
  }

  private setupLifecycleHooks() {
    if (typeof window === 'undefined') return;

    window.addEventListener('online', () => {
      if (!this.isConnected) {
        this.reconnect();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (!this.isConnected) {
          this.reconnect();
        } else {
          this.requestSync();
        }
      }
    });

    // Check health every 8 seconds
    this.pingInterval = setInterval(() => {
      if (!this.isConnected && typeof navigator !== 'undefined' && navigator.onLine) {
        this.reconnect();
      }
    }, 8000);
  }

  private init() {
    if (typeof window === 'undefined') return;

    if (this.client) {
      try { this.client.end(true); } catch {}
      this.client = null;
    }

    const brokerUrl = this.brokers[this.currentBrokerIndex % this.brokers.length];

    try {
      this.client = mqtt.connect(brokerUrl, {
        clientId: this.clientId,
        clean: true,
        reconnectPeriod: 3000,
        connectTimeout: 7000,
        keepalive: 30
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        this.client?.subscribe([TOPIC_ACTION, TOPIC_SYNC, TOPIC_NOTIF, TOPIC_REQ], { qos: 1 });

        // Request latest state upon connecting from active peers
        setTimeout(() => {
          this.requestSync();
        }, 400);
      });

      this.client.on('message', (topic, message) => {
        try {
          const raw = message.toString();
          if (!raw) return;
          const parsed = JSON.parse(raw);

          if (topic === TOPIC_ACTION) {
            if (parsed.senderId !== this.clientId && parsed.action) {
              this.actionListeners.forEach((listener) => {
                try { listener(parsed.action, parsed.senderId); } catch (e) {}
              });
            }
          } else if (topic === TOPIC_SYNC) {
            if (parsed && (Array.isArray(parsed.tournaments) || Array.isArray(parsed.teams))) {
              if (parsed.senderId !== this.clientId) {
                this.stateListeners.forEach((listener) => {
                  try { listener(parsed); } catch (e) {}
                });
              }
            }
          } else if (topic === TOPIC_NOTIF) {
            this.notifListeners.forEach((listener) => {
              try { listener(parsed); } catch (e) {}
            });
          } else if (topic === TOPIC_REQ) {
            if (parsed.senderId !== this.clientId && parsed.type === 'REQUEST_SYNC') {
              this.actionListeners.forEach((listener) => {
                try { listener(parsed, parsed.senderId); } catch (e) {}
              });
            }
          }
        } catch (err) {}
      });

      this.client.on('error', () => {
        this.isConnected = false;
        this.scheduleFailover();
      });

      this.client.on('offline', () => {
        this.isConnected = false;
      });

      this.client.on('close', () => {
        this.isConnected = false;
      });
    } catch (e) {
      this.isConnected = false;
      this.scheduleFailover();
    }
  }

  private scheduleFailover() {
    if (this.retryTimeout) return;
    this.retryTimeout = setTimeout(() => {
      this.retryTimeout = null;
      if (!this.isConnected) {
        this.currentBrokerIndex++;
        this.init();
      }
    }, 4000);
  }

  public reconnect() {
    this.init();
  }

  public requestSync() {
    if (!this.client || !this.isConnected) return;
    try {
      this.client.publish(
        TOPIC_REQ, 
        JSON.stringify({ type: 'REQUEST_SYNC', senderId: this.clientId, timestamp: Date.now() }), 
        { qos: 1 }
      );
    } catch {}
  }

  public subscribeAction(listener: ActionListener): () => void {
    this.actionListeners.add(listener);
    return () => {
      this.actionListeners.delete(listener);
    };
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

  public publishAction(action: RealtimeAction) {
    if (!this.client || !this.isConnected) return;
    try {
      const payload = {
        senderId: this.clientId,
        action,
        timestamp: Date.now()
      };
      this.client.publish(TOPIC_ACTION, JSON.stringify(payload), { qos: 1 });
    } catch (err) {}
  }

  public publishState(payload: SyncPayload) {
    if (!this.client || !this.isConnected) return;
    try {
      payload.senderId = this.clientId;
      const str = JSON.stringify(payload);
      // Retain state with QoS 1 so any newly opened visitor tab gets the latest tournament state immediately
      this.client.publish(TOPIC_SYNC, str, { retain: true, qos: 1 });
    } catch (err) {}
  }

  public publishNotification(notification: any) {
    if (this.client && this.isConnected) {
      try {
        this.client.publish(TOPIC_NOTIF, JSON.stringify(notification), { qos: 1 });
      } catch {}
    }
  }
}

export const realtimeSync = new RealtimeSyncManager();
