import { Redis } from '@upstash/redis';
import 'dotenv/config';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

async function testRedis() {
  console.log('🧪 Testing Upstash Redis connection...\n');

  try {
    // Test 1: Simple SET/GET
    console.log('Test 1: Setting a test value...');
    await redis.set('test:key', 'Hello from test!');
    console.log('✅ SET successful');

    const value = await redis.get('test:key');
    console.log('✅ GET successful:', value);

    // Test 2: Push to queue (like webhook does)
    console.log('\nTest 2: Pushing to instagram:mentions queue...');
    const testJob = {
      id: `test_${Date.now()}`,
      mediaId: '17887498072083520',
      commentId: '17887498072083520',
      username: 'aicheckr',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    await redis.lpush('instagram:mentions', JSON.stringify(testJob));
    console.log('✅ LPUSH successful');

    // Test 3: Check what's in the queue
    console.log('\nTest 3: Reading from queue...');
    const queueItems = await redis.lrange('instagram:mentions', 0, -1);
    console.log('✅ Queue contents:', queueItems);
    console.log('📊 Queue length:', queueItems.length);

    // Test 4: Pop from queue (like agent does)
    console.log('\nTest 4: Popping from queue...');
    const popped = await redis.rpop('instagram:mentions');
    console.log('✅ RPOP successful:', popped);

    console.log('\n✅ All tests passed! Upstash is working correctly.');
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testRedis();