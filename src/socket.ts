import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from './config/env';
import { JwtPayload } from './types';
import prisma from './config/database';

let io: SocketServer | null = null;

export function initSocket(server: HttpServer): SocketServer {
  io = new SocketServer(server, {
    cors: {
      origin: [env.DASHBOARD_URL, env.WEB_URL],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.use(async (socket: Socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      next(new Error('Authentication required'));
      return;
    }

    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || !user.is_active) {
        next(new Error('User not found or inactive'));
        return;
      }

      // Attach tenant info to socket
      (socket as Socket & { tenantId: string }).tenantId = user.tenant_id;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const tenantId = (socket as Socket & { tenantId: string }).tenantId;

    // Join tenant-specific room
    socket.join(`tenant:${tenantId}`);
    console.log(`🔌 Socket connected: tenant=${tenantId} socket=${socket.id}`);

    socket.on('disconnect', () => {
      console.log(`🔌 Socket disconnected: ${socket.id}`);
    });

    // Allow client to manually join/leave rooms (e.g. conversation rooms)
    socket.on('join:conversation', (conversationId: string) => {
      socket.join(`conversation:${conversationId}`);
    });

    socket.on('leave:conversation', (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`);
    });
  });

  console.log('✅ Socket.io initialised');
  return io;
}

export function getIo(): SocketServer {
  if (!io) {
    throw new Error('Socket.io has not been initialised. Call initSocket(server) first.');
  }
  return io;
}
