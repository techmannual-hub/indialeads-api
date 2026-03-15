import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Demo tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo' },
    update: {},
    create: {
      name: 'Demo Company',
      slug: 'demo',
      is_demo: true,
      plan: 'STARTER',
      onboarding_done: true,
    },
  });

  // Demo user
  const passwordHash = await bcrypt.hash('demo@1234', 12);
  const user = await prisma.user.upsert({
    where: { email: 'demo@indialeadscrm.com' },
    update: {},
    create: {
      tenant_id: tenant.id,
      email: 'demo@indialeadscrm.com',
      password_hash: passwordHash,
      name: 'Demo User',
    },
  });

  // License
  await prisma.license.upsert({
    where: { tenant_id: tenant.id },
    update: {},
    create: {
      tenant_id: tenant.id,
      license_key: `STARTER-${crypto.randomBytes(4).toString('hex').toUpperCase()}-DEMO`,
      plan: 'STARTER',
      status: 'ACTIVE',
      max_leads: 5000,
      max_messages: 1000,
    },
  });

  // Sample tags
  const tags = await Promise.all([
    prisma.tag.upsert({
      where: { tenant_id_name: { tenant_id: tenant.id, name: 'Hot Lead' } },
      update: {},
      create: { tenant_id: tenant.id, name: 'Hot Lead', color: '#ef4444' },
    }),
    prisma.tag.upsert({
      where: { tenant_id_name: { tenant_id: tenant.id, name: 'Interested' } },
      update: {},
      create: { tenant_id: tenant.id, name: 'Interested', color: '#22c55e' },
    }),
    prisma.tag.upsert({
      where: { tenant_id_name: { tenant_id: tenant.id, name: 'Follow Up' } },
      update: {},
      create: { tenant_id: tenant.id, name: 'Follow Up', color: '#f59e0b' },
    }),
  ]);

  // Sample leads
  const sampleLeads = [
    { name: 'Rahul Sharma', phone: '+919876543210', products: ['Solar Panel'], status: 'LIVE' as const, stage: 'Qualified' },
    { name: 'Priya Singh', phone: '+919876543211', products: ['Water Heater'], status: 'PENDING' as const, stage: 'New' },
    { name: 'Amit Patel', phone: '+919876543212', products: ['LED Lights'], status: 'COOLING' as const, stage: 'Follow Up',
      cooling_until: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
    { name: 'Sunita Mehta', phone: '+919876543213', products: ['Solar Panel', 'LED Lights'], status: 'LIVE' as const, stage: 'Proposal' },
    { name: 'Vijay Kumar', phone: '+919876543214', products: ['Water Heater'], status: 'DEAD' as const, stage: 'Lost' },
  ];

  for (const lead of sampleLeads) {
    await prisma.lead.upsert({
      where: { tenant_id_phone: { tenant_id: tenant.id, phone: lead.phone } },
      update: {},
      create: {
        tenant_id: tenant.id,
        name: lead.name,
        phone: lead.phone,
        products: lead.products,
        status: lead.status,
        stage: lead.stage,
        source: 'DEMO',
        cooling_until: 'cooling_until' in lead ? lead.cooling_until : null,
      },
    });
  }

  // Sample approved template
  await prisma.template.upsert({
    where: { tenant_id_name: { tenant_id: tenant.id, name: 'welcome_message' } },
    update: {},
    create: {
      tenant_id: tenant.id,
      name: 'welcome_message',
      category: 'MARKETING',
      language: 'en',
      body: 'Hi {{1}}, thank you for your interest in {{2}}. Our team will contact you shortly.',
      variables: [{ key: '1', example: 'Rahul' }, { key: '2', example: 'Solar Panels' }],
      status: 'APPROVED',
      wa_template_id: 'demo_template_001',
    },
  });

  // Sample automation
  await prisma.automation.upsert({
    where: {
      id: 'demo-automation-001',
    },
    update: {},
    create: {
      id: 'demo-automation-001',
      tenant_id: tenant.id,
      name: 'Welcome new lead',
      description: 'Send welcome message when a lead is created',
      trigger: 'LEAD_CREATED',
      conditions: [],
      actions: [{ type: 'UPDATE_STATUS', status: 'PENDING' }],
      is_active: false, // off by default in demo
    },
  });

  console.log(`✅ Seeded:`);
  console.log(`   Tenant: ${tenant.name} (slug: ${tenant.slug})`);
  console.log(`   User:   ${user.email} / password: demo@1234`);
  console.log(`   Leads:  ${sampleLeads.length}`);
  console.log(`   Tags:   ${tags.length}`);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
