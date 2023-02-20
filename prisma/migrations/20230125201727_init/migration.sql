/*
  Warnings:

  - Added the required column `class` to the `Process` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `type` on the `Process` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "Process" ADD COLUMN     "class" "ProcessClass" NOT NULL,
DROP COLUMN "type",
ADD COLUMN     "type" TEXT NOT NULL;
