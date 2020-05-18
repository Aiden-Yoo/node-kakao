/*
 * Created on Sat May 16 2020
 *
 * Copyright (c) storycraft. Licensed under the MIT Licence.
 */

import { EventEmitter } from "events";
import { LocoPacketHandler, NetworkManager, LocoKickoutType, LocoRequestPacket, LocoResponsePacket, ChatChannel, ChatFeed, Long, FeedType, OpenChannelInfo } from "..";
import { PacketMessageRes } from "../packet/packet-message";
import { PacketMessageReadRes } from "../packet/packet-message-read";
import { PacketNewMemberRes } from "../packet/packet-new-member";
import { PacketSyncDeleteMessageRes } from "../packet/packet-sync-delete-message";
import { PacketLeftRes, PacketLeaveRes, PacketLeaveReq } from "../packet/packet-leave";
import { PacketLinkKickedRes } from "../packet/packet-link-kicked";
import { PacketChanJoinRes } from "../packet/packet-chan-join";
import { PacketJoinLinkRes } from "../packet/packet-join-link";
import { PacketSyncJoinOpenchatRes } from "../packet/packet-sync-join-openchat";
import { PacketSyncMemberTypeRes } from "../packet/packet-sync-member-type";
import { PacketSyncProfileRes } from "../packet/packet-sync-profile";
import { PacketKickMemberRes } from "../packet/packet-kick-member";
import { PacketDeleteMemberRes } from "../packet/packet-delmem";
import { PacketKickoutRes } from "../packet/packet-kickout";

export class TalkPacketHandler extends EventEmitter implements LocoPacketHandler {

    private networkManager: NetworkManager;

    private kickReason: LocoKickoutType;

    constructor(networkManager: NetworkManager) {
        super();

        this.kickReason = LocoKickoutType.UNKNOWN;

        this.networkManager = networkManager;

        this.setMaxListeners(1000);

        this.on('MSG', this.onMessagePacket.bind(this));
        this.on('NEWMEM', this.onNewMember.bind(this));
        this.on('DECUNREAD', this.onMessageRead.bind(this));
        this.on('JOINLINK', this.onOpenChannelJoin.bind(this));
        this.on('SYNCLINKCR', this.syncOpenChannelJoin.bind(this));
        this.on('SYNCMEMT', this.syncMemberTypeChange.bind(this));
        this.on('SYNCLINKPF', this.syncProfileUpdate.bind(this));
        this.on('KICKMEM', this.onOpenChannelKick.bind(this));
        this.on('DELMEM', this.onMemberDelete.bind(this));
        this.on('LINKKICKED', this.onLinkKicked.bind(this));
        this.on('SYNCJOIN', this.onChannelJoin.bind(this));
        this.on('SYNCDLMSG', this.syncMessageDelete.bind(this));
        this.on('LEFT', this.onChannelLeft.bind(this));
        this.on('LEAVE', this.onChannelLeave.bind(this));
        this.on('KICKOUT', this.onLocoKicked.bind(this));
    }

    get NetworkManager() {
        return this.networkManager;
    }

    get Client() {
        return this.networkManager.Client;
    }

    get ChatManager() {
        return this.Client.ChatManager;
    }

    get ChannelManager() {
        return this.Client.ChannelManager;
    }
    
    get UserManager() {
        return this.Client.UserManager;
    }

    onRequest(packetId: number, packet: LocoRequestPacket): void {

    }
    
    onResponse(packetId: number, packet: LocoResponsePacket, reqPacket?: LocoRequestPacket): void {
        this.emit(packet.PacketName, packet, reqPacket);
    }

    onDisconnected(): void {
        this.Client.emit('disconnected', this.kickReason);
    }

    async onMessagePacket(packet: PacketMessageRes) {
        let channel: ChatChannel = await this.ChannelManager.get(packet.ChannelId);

        let chatLog = packet.Chatlog;
        let chat = await this.ChatManager.chatFromChatlog(chatLog);

        let userInfo = (await chat.Channel.getChannelInfo()).getUserInfo(chat.Sender);

        if (userInfo) chat.Sender.updateNickname(packet.SenderNickname);

        channel.chatReceived(chat);
    }

    async onMessageRead(packet: PacketMessageReadRes) {
        let channel = await this.ChannelManager.get(packet.ChannelId);

        let channelInfo = await channel.getChannelInfo();

        let reader = this.UserManager.get(packet.ReaderId);

        let watermark = packet.Watermark;

        reader.emit('message_read', channel, watermark);
        this.Client.emit('message_read', channel, reader, watermark);
    }

    async onNewMember(packet: PacketNewMemberRes) {
        let channel = await this.ChannelManager.get(packet.Chatlog.ChannelId);

        let channelInfo = await channel.getChannelInfo();

        let chatlog = packet.Chatlog;

        let feed = ChatFeed.getFeedFromText(chatlog.Text);

        let idList: Long[] = [];

        if (feed.FeedType === FeedType.INVITE && feed.MemberList) {
            for (let member of feed.MemberList) {
                idList.push(member.UserId);
            }
        } else if (feed.FeedType === FeedType.OPENLINK_JOIN && feed.Member) {
            idList.push(feed.Member.UserId);
        }

        for(let id of idList) {
            let user = this.UserManager.get(id);

            if (user.isClientUser()) {
                user.emit('join', channel, feed);
                this.Client.emit('join_channel', channel);
            } else {
                await channelInfo.addUserInfo(id);

                user.emit('join', channel, feed);
                channel.emit('join', user, feed);
                this.Client.emit('user_join', channel, user, feed);
            }
        }
    }

    async syncMessageDelete(packet: PacketSyncDeleteMessageRes) {
        let chat = await this.ChatManager.chatFromChatlog(packet.Chatlog);

        if (!chat.isFeed()) return;

        let feed = chat.getFeed();

        if (feed.FeedType !== FeedType.DELETE_TO_ALL) return;

        this.Client.emit('message_deleted', feed.LogId! || Long.ZERO, feed.Hidden! || false);
    }

    async onChannelLeft(packet: PacketLeftRes) {
        let channel = await this.ChannelManager.get(packet.ChannelId);

        this.Client.emit('left_channel', channel);
        this.ChannelManager.removeChannel(channel);
    }

    async onChannelLeave(packet: PacketLeaveRes, reqPacket?: PacketLeaveReq) {
        if (!reqPacket) return;

        let chanId = reqPacket.ChannelId;

        if (!this.ChannelManager.has(chanId)) return;

        let channel = await this.ChannelManager.get(chanId);

        this.Client.emit('left_channel', channel);
        this.ChannelManager.removeChannel(channel);
    }

    async onLinkKicked(packet: PacketLinkKickedRes) {
        let channel = await this.ChannelManager.get(packet.ChannelId);

        this.Client.emit('left_channel', channel);
        this.ChannelManager.removeChannel(channel);
    }

    async onChannelJoin(packet: PacketChanJoinRes) {
        let chanId = packet.ChannelId;

        let newChan = await this.ChannelManager.get(chanId);

        this.Client.emit('join_channel', newChan);
    }

    async onOpenChannelJoin(packet: PacketJoinLinkRes) {
        if (!packet.ChatInfo) return;

        let chanId = packet.ChatInfo.ChannelId;

        if (this.ChannelManager.has(chanId)) return;
        
        let newChan = await this.ChannelManager.get(chanId);

        this.Client.emit('join_channel', newChan);
    }

    async syncOpenChannelJoin(packet: PacketSyncJoinOpenchatRes) {
        if (!packet.ChatInfo) return; // DO NOTHING IF ITS NOT CREATING CHAT CHANNEL

        let chanId = packet.ChatInfo.ChannelId;

        if (this.ChannelManager.has(chanId)) return;
        
        let newChan = await this.ChannelManager.get(chanId);

        this.Client.emit('join_channel', newChan);
    }

    async syncMemberTypeChange(packet: PacketSyncMemberTypeRes) {
        let chanId = packet.ChannelId;

        let channel = await this.ChannelManager.get(chanId);
        
        if (!channel.isOpenChat()) return;

        let info = (await channel.getChannelInfo()) as OpenChannelInfo;

        let len = packet.MemberIdList.length;
        for (let i = 0; i < len; i++) {
            info.updateMemberType(packet.MemberIdList[i], packet.MemberTypeList[i]);
        }
    }
    
    async syncProfileUpdate(packet: PacketSyncProfileRes) {
        let chanId = packet.ChannelId;

        if (chanId.equals(Long.ZERO)) return;

        let channel = await this.ChannelManager.get(chanId);

        let info = await channel.getChannelInfo();

        let userInfo = info.getUserInfoId(packet.OpenMember.UserId);

        if (!userInfo) return;

        userInfo.updateFromOpenStruct(packet.OpenMember);
    }

    async onOpenChannelKick(packet: PacketKickMemberRes) {
        let chanId = packet.ChannelId;

        if (!this.ChannelManager.has(chanId)) return;
        
        let channel = await this.ChannelManager.get(chanId);

        let chat = await this.ChatManager.chatFromChatlog(packet.Chatlog);

        if (!chat.isFeed()) return;

        let feed = chat.getFeed();

        if (!feed.Member) return;

        let info = await chat.Channel.getChannelInfo();

        let kickedUser = this.UserManager.get(feed.Member.UserId);

        kickedUser.emit('left', channel, feed);
        channel.emit('left', kickedUser, feed);
        this.Client.emit('user_left', kickedUser, feed);

        if (!this.Client.ClientUser.Id.equals(feed.Member.UserId)) info.removeUserInfo(feed.Member.UserId);
    }

    async onMemberDelete(packet: PacketDeleteMemberRes) {
        let chatLog = packet.Chatlog;

        let channel = await this.ChannelManager.get(chatLog.ChannelId);
        let chat = await this.ChatManager.chatFromChatlog(chatLog);

        if (!chat.isFeed()) return;

        let feed = chat.getFeed();

        if (!feed.Member) return;
        
        let info = await chat.Channel.getChannelInfo();
            
        let leftUser = this.UserManager.get(feed.Member.UserId);

        leftUser.emit('left', channel, feed);
        channel.emit('left', leftUser, feed);
        this.Client.emit('user_left', leftUser, feed);

        info.removeUserInfo(feed.Member.UserId);
    }

    onLocoKicked(packet: PacketKickoutRes) {
        let reason = packet.Reason;

        this.kickReason = reason;
    }
}