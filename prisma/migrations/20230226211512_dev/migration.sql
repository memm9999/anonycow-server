-- DropForeignKey
ALTER TABLE "FortuneItem" DROP CONSTRAINT "FortuneItem_userId_fkey";

-- AlterTable
ALTER TABLE "FortuneItem" ALTER COLUMN "userId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "FortuneItem" ADD CONSTRAINT "FortuneItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
